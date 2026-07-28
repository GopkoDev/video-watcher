import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, SESSIONS_DIR } from "../config.js";
import { withVideo } from "../ffmpeg/workspace.js";
import {
  calculateAutoFps,
  extractFrames,
  extractFramesBySegments,
  frameFormatMimeType,
  probeVideo,
} from "../extractors/frames.js";
import { extractPcm } from "../extractors/audio.js";
import { emptyAudioResult, transcribe } from "../asr/whisper.js";
import { resolveWhisperModel } from "../asr/models.js";
import { parseHMS, shiftAudioResult } from "../utils/timestamps.js";
import { resolveVideoPath } from "../utils/video-path.js";
import { computeVideoHash, getSessionDir, loadManifest, saveManifest } from "../session/manager.js";
import { createManifest, frameCacheKey, mergeFrames, sampleFrameIndices } from "../session/manifest.js";
import { cacheFrames } from "../session/cache.js";
import type { AudioResult, Frame, Segment, SessionManifest } from "../types.js";

const HMS_REGEX = /^\d{2}:\d{2}:\d{2}$/;

/** Frames per segment are bounded separately — a segment is already narrow. */
const MAX_FRAMES_PER_SEGMENT = 1000;

export interface DeriveFpsParams {
  fps: number | "auto";
  view_sample?: number;
  start_time?: string;
  end_time?: string;
  segments?: { start: string; end: string }[];
  duration_seconds: number;
}

export function deriveFps(params: DeriveFpsParams): number {
  const usingSegments = params.segments && params.segments.length > 0;

  if (params.fps === "auto") {
    if (params.view_sample && !usingSegments) {
      const startSec = params.start_time ? parseHMS(params.start_time) : 0;
      const endSec = params.end_time ? parseHMS(params.end_time) : params.duration_seconds;
      const activeDuration = Math.max(1, endSec - startSec);
      return params.view_sample / activeDuration;
    }
    return calculateAutoFps(params.duration_seconds);
  }

  return params.fps;
}

export function registerVideoWatch(server: McpServer): void {
  server.tool(
    "video_watch",
    "Extract frames and transcribe audio from a local video file. Returns frames as images plus a timestamped transcript so Claude can see and hear the video. IMPORTANT: for videos longer than 30 seconds call video_analyze FIRST to get structural data (scene changes, silence, transcript), then use it to pick smart segments with variable FPS instead of extracting the whole file.",
    {
      path: z.string().describe("Path to a local video file (~ is expanded)"),
      fps: z.union([z.coerce.number().positive(), z.literal("auto")]).optional().describe("Frames per second to extract; defaults to the configured value"),
      resolution: z.coerce.number().min(128).max(2048).optional().describe("Frame width in px (aspect ratio preserved)"),
      frame_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Frame image format"),
      start_time: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format").optional().describe("Absolute start time, e.g. '00:01:30'"),
      end_time: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format").optional().describe("Absolute end time, e.g. '00:05:00'"),
      language: z.string().optional().describe("ISO-639-1 code for transcription, or 'auto' to detect"),
      skip_audio: z.boolean().default(false).describe("Frames only — skip transcription"),
      segments: z.array(z.object({
        start: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        end: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        fps: z.number().positive(),
        resolution: z.number().min(128).max(2048).optional(),
      })).optional().describe("Variable FPS/resolution segments — overrides fps/start_time/end_time for frames"),
      view_sample: z.number().min(1).optional().describe("Return only N evenly spaced frames"),
    },
    async (params) => {
      const config = loadConfig();
      const videoPath = resolveVideoPath(params.path);
      const resolution = params.resolution ?? config.frame_resolution;
      const frameFormat = params.frame_format ?? config.frame_format;
      const maxInputBytes = config.max_input_mb * 1024 * 1024;

      // Everything that needs ffmpeg happens in one exclusive scope so the
      // video is copied into wasm memory only once.
      const extracted = await withVideo(videoPath, maxInputBytes, (ws) => {
        const metadata = probeVideo(ws);

        const fps = deriveFps({
          fps: params.fps ?? config.default_fps,
          view_sample: params.view_sample,
          start_time: params.start_time,
          end_time: params.end_time,
          segments: params.segments,
          duration_seconds: metadata.duration_seconds,
        });

        let frames: Frame[];
        let truncated = false;

        if (params.segments && params.segments.length > 0) {
          frames = extractFramesBySegments(
            ws,
            params.segments as Segment[],
            frameFormat,
            resolution,
            MAX_FRAMES_PER_SEGMENT,
          );
        } else {
          const result = extractFrames(ws, {
            fps,
            resolution,
            format: frameFormat,
            startTime: params.start_time,
            endTime: params.end_time,
            maxFrames: config.max_frames,
          });
          frames = result.frames;
          truncated = result.truncated;
        }

        const pcm = !params.skip_audio && metadata.has_audio
          ? extractPcm(ws, { startTime: params.start_time, endTime: params.end_time })
          : null;

        return { metadata, fps, frames, truncated, pcm };
      });

      const { metadata, fps, truncated, pcm } = extracted;
      let frames = extracted.frames;

      // Transcription runs outside the ffmpeg lock — it is the slow part and
      // needs no ffmpeg.
      let audio: AudioResult;
      if (params.skip_audio) {
        audio = emptyAudioResult("skip_audio was set");
      } else if (!metadata.has_audio) {
        audio = emptyAudioResult("video has no audio track");
      } else {
        const spec = resolveWhisperModel(config.whisper_model);
        const raw = await transcribe(pcm!, {
          spec,
          language: params.language ?? config.whisper_language,
        });
        // Backends time the transcript from the start of the extracted audio;
        // frames already carry absolute timestamps.
        audio = shiftAudioResult(raw, params.start_time ? parseHMS(params.start_time) : 0);
      }

      // Session cache
      let manifest: SessionManifest | null = null;
      if (config.enable_index) {
        const sessionDir = getSessionDir(SESSIONS_DIR, videoPath);
        manifest = loadManifest(sessionDir) ?? createManifest(computeVideoHash(videoPath), videoPath);

        const byResolution = new Map<number, Frame[]>();
        for (const frame of frames) {
          const res = (frame as { resolution?: number }).resolution ?? resolution;
          byResolution.set(res, [...(byResolution.get(res) ?? []), frame]);
        }

        for (const [res, group] of byResolution) {
          const entries = cacheFrames(sessionDir, frameFormat, res, group);
          manifest = mergeFrames(manifest, frameCacheKey(res, frameFormat), entries);
        }

        saveManifest(sessionDir, manifest);
      }

      if (params.view_sample && frames.length > params.view_sample) {
        frames = sampleFrameIndices(frames.length, params.view_sample).map((i) => frames[i]);
      }

      // ---- MCP content ----
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [];

      if (manifest) {
        const summary = {
          video_hash: manifest.video_hash,
          resolutions: Object.fromEntries(
            Object.entries(manifest.resolutions).map(([key, data]) => [
              key,
              { frame_count: data.frames.length, timestamps: data.frames.map((f) => f.timestamp) },
            ]),
          ),
        };
        content.push({ type: "text", text: `## Session Manifest\n${JSON.stringify(summary, null, 2)}` });
      }

      if (truncated) {
        content.push({
          type: "text",
          text:
            `## Warning\nExtraction stopped at max_frames (${config.max_frames}), so the frames below cover only ` +
            `the first ${(config.max_frames / fps).toFixed(0)}s of the requested range. Lower the fps, narrow the ` +
            `range, or raise max_frames with video_configure.`,
        });
      }

      content.push({
        type: "text",
        text: `## Video Metadata\n${JSON.stringify(metadata, null, 2)}\n\n## Audio\n${JSON.stringify(audio, null, 2)}`,
      });

      const mimeType = frameFormatMimeType(frameFormat);
      for (const frame of frames) {
        content.push({ type: "text", text: `### Frame at ${frame.timestamp}` });
        if (frame.image) {
          content.push({ type: "image", data: frame.image, mimeType });
        }
      }

      return { content: content as any };
    },
  );
}
