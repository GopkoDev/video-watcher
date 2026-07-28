import { z } from "zod";
import { readFileSync } from "fs";
import { extname } from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, SESSIONS_DIR } from "../config.js";
import { withVideo } from "../ffmpeg/workspace.js";
import { extractFramesBySegments, frameFormatMimeType } from "../extractors/frames.js";
import type { SegmentFrame } from "../extractors/frames.js";
import { resolveVideoPath } from "../utils/video-path.js";
import { computeVideoHash, getSessionDir, loadManifest, saveManifest } from "../session/manager.js";
import { createManifest, frameCacheKey, mergeFrames, sampleFrameIndices } from "../session/manifest.js";
import { cacheFrames } from "../session/cache.js";
import type { FrameFormat, Segment, SessionManifest } from "../types.js";

const HMS_REGEX = /^\d{2}:\d{2}:\d{2}$/;
const MAX_FRAMES_PER_SEGMENT = 1000;

interface ViewableFrame {
  timestamp: string;
  image?: string;
  mimeType?: string;
}

function mimeTypeFromFile(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function readCached(timestamp: string, file: string): ViewableFrame {
  try {
    return { timestamp, image: readFileSync(file).toString("base64"), mimeType: mimeTypeFromFile(file) };
  } catch {
    // The cache entry outlived the file; report the timestamp without an image.
    return { timestamp };
  }
}

/**
 * Flat pool of frames available for viewing.
 *
 * Frames extracted in this call win; otherwise the session cache is read back,
 * de-duplicated by timestamp, preferring the highest resolution on disk.
 */
function buildViewablePool(
  extracted: SegmentFrame[],
  manifest: SessionManifest | null,
  format: FrameFormat,
): ViewableFrame[] {
  if (extracted.length > 0) {
    return extracted.map((f) => ({
      timestamp: f.timestamp,
      image: f.image,
      mimeType: frameFormatMimeType(f.format ?? format),
    }));
  }

  if (!manifest) return [];

  const byTimestamp = new Map<string, { res: number; file: string }>();
  for (const [cacheKey, data] of Object.entries(manifest.resolutions)) {
    const [resStr, cachedFormat = "jpeg"] = cacheKey.split("/");
    if (cachedFormat !== format) continue;

    const res = parseInt(resStr, 10);
    for (const entry of data.frames) {
      const current = byTimestamp.get(entry.timestamp);
      if (!current || res > current.res) byTimestamp.set(entry.timestamp, { res, file: entry.file });
    }
  }

  return Array.from(byTimestamp.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, { file }]) => readCached(timestamp, file));
}

function lookupTimestamps(
  manifest: SessionManifest,
  timestamps: string[],
  format: FrameFormat,
): ViewableFrame[] {
  const result: ViewableFrame[] = [];

  for (const ts of timestamps) {
    let bestRes = -1;
    let bestFile: string | null = null;

    for (const [cacheKey, data] of Object.entries(manifest.resolutions)) {
      const [resStr, cachedFormat = "jpeg"] = cacheKey.split("/");
      if (cachedFormat !== format) continue;

      const res = parseInt(resStr, 10);
      const entry = data.frames.find((f) => f.timestamp === ts);
      if (entry && res > bestRes) {
        bestRes = res;
        bestFile = entry.file;
      }
    }

    // Timestamps with no cached frame are skipped rather than reported as errors.
    if (bestFile !== null) result.push(readCached(ts, bestFile));
  }

  return result;
}

export function registerVideoDetail(server: McpServer): void {
  server.tool(
    "video_detail",
    "Drill into specific moments of a local video file. Extracts frames at per-segment FPS and resolution, and separates extraction from viewing: extract a lot, then return only the frames you actually need via view/view_sample. With enable_index on, frames are cached and de-duplicated across calls.",
    {
      path: z.string().describe("Path to a local video file (~ is expanded)"),
      segments: z.array(z.object({
        start: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        end: z.string().regex(HMS_REGEX, "Must be HH:MM:SS format"),
        fps: z.number().positive(),
        resolution: z.number().min(128).max(2048).optional(),
      })).optional().describe("Segments to extract frames from"),
      view: z.array(z.string().regex(HMS_REGEX, "Must be HH:MM:SS format")).optional()
        .describe("Exact timestamps to return as images"),
      view_sample: z.number().min(1).optional().describe("Return N evenly spaced frames from the extracted set"),
      frame_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Frame image format"),
      skip_cached: z.boolean().default(true).describe("Do not rewrite frames already cached at the same resolution"),
    },
    async (params) => {
      const config = loadConfig();
      const videoPath = resolveVideoPath(params.path);
      const frameFormat = params.frame_format ?? config.frame_format;

      let manifest: SessionManifest | null = null;
      let sessionDir: string | null = null;

      if (config.enable_index) {
        sessionDir = getSessionDir(SESSIONS_DIR, videoPath);
        manifest = loadManifest(sessionDir) ?? createManifest(computeVideoHash(videoPath), videoPath);
      }

      let extracted: SegmentFrame[] = [];

      if (params.segments && params.segments.length > 0) {
        extracted = await withVideo(videoPath, config.max_input_mb * 1024 * 1024, (ws) =>
          extractFramesBySegments(
            ws,
            params.segments as Segment[],
            frameFormat,
            config.frame_resolution,
            MAX_FRAMES_PER_SEGMENT,
          ),
        );

        if (manifest && sessionDir) {
          const byResolution = new Map<number, SegmentFrame[]>();
          for (const frame of extracted) {
            byResolution.set(frame.resolution, [...(byResolution.get(frame.resolution) ?? []), frame]);
          }

          for (const [resolution, group] of byResolution) {
            const entries = cacheFrames(sessionDir, frameFormat, resolution, group, params.skip_cached);
            manifest = mergeFrames(manifest, frameCacheKey(resolution, frameFormat), entries);
          }

          saveManifest(sessionDir, manifest);
        }
      }

      let framesToView: ViewableFrame[];

      if (params.view && params.view.length > 0) {
        framesToView = manifest
          ? lookupTimestamps(manifest, params.view, frameFormat)
          : extracted
              .filter((f) => params.view!.includes(f.timestamp))
              .map((f) => ({
                timestamp: f.timestamp,
                image: f.image,
                mimeType: frameFormatMimeType(f.format ?? frameFormat),
              }));
      } else if (params.view_sample !== undefined) {
        const pool = buildViewablePool(extracted, manifest, frameFormat);
        framesToView = sampleFrameIndices(pool.length, params.view_sample).map((i) => pool[i]);
      } else {
        framesToView = buildViewablePool(extracted, manifest, frameFormat);
      }

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

      content.push({ type: "text", text: `## Viewing ${framesToView.length} frame(s)` });

      for (const frame of framesToView) {
        content.push({ type: "text", text: `### Frame at ${frame.timestamp}` });
        if (frame.image) {
          content.push({ type: "image", data: frame.image, mimeType: frame.mimeType ?? "image/jpeg" });
        }
      }

      return { content: content as any };
    },
  );
}
