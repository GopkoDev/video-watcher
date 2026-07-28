import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, SESSIONS_DIR } from "../config.js";
import { withVideo } from "../ffmpeg/workspace.js";
import { probeVideo } from "../extractors/frames.js";
import { extractPcm } from "../extractors/audio.js";
import { transcribe } from "../asr/whisper.js";
import { resolveWhisperModel } from "../asr/models.js";
import {
  buildAnalysisCommand,
  deriveContentProfile,
  parseBlackdetectOutput,
  parseBlurOutput,
  parseEbur128Output,
  parseFreezeOutput,
  parseScdetFromMetaFile,
  parseScdetOutput,
  parseSignalstatsOutput,
  parseSilenceOutput,
  parseSitiOutput,
} from "../extractors/analyzers.js";
import { resolveVideoPath } from "../utils/video-path.js";
import { computeVideoHash, getSessionDir, loadManifest, saveManifest } from "../session/manager.js";
import { createManifest } from "../session/manifest.js";
import type { AnalysisFilters, VideoAnalysis } from "../types.js";

export function registerVideoAnalyze(server: McpServer): void {
  server.tool(
    "video_analyze",
    "Analyze the structure of a local video file with ffmpeg filters: scene changes, black frames, silence, freezes, motion, blur, exposure and loudness, plus an optional transcript. Does NOT extract frames — use it before video_watch to decide which parts of the video are worth looking at.",
    {
      path: z.string().describe("Path to a local video file (~ is expanded)"),
      filters: z.object({
        scene_changes: z.boolean().default(false).describe("Detect scene cuts (scdet)"),
        black_intervals: z.boolean().default(false).describe("Detect black frames/transitions (blackdetect)"),
        silence: z.boolean().default(false).describe("Detect silence intervals (silencedetect)"),
        freeze: z.boolean().default(false).describe("Detect frozen/still segments (freezedetect)"),
        motion: z.boolean().default(false).describe("Measure visual complexity and motion (siti)"),
        blur: z.boolean().default(false).describe("Measure blur/sharpness per frame (blurdetect)"),
        exposure: z.boolean().default(false).describe("Measure brightness and saturation per frame (signalstats)"),
        loudness: z.boolean().default(false).describe("Measure audio loudness — speech vs music (ebur128)"),
        transcription: z.boolean().default(false).describe("Transcribe the audio with whisper"),
      }),
      language: z.string().optional().describe("ISO-639-1 code for transcription, or 'auto' to detect"),
    },
    async (params) => {
      const config = loadConfig();
      const videoPath = resolveVideoPath(params.path);
      const filters = params.filters as AnalysisFilters;
      const maxInputBytes = config.max_input_mb * 1024 * 1024;

      const { metadata, analysis, pcm } = await withVideo(videoPath, maxInputBytes, (ws) => {
        const metadata = probeVideo(ws);

        const analysis: VideoAnalysis = {
          scenes: [],
          black_intervals: [],
          silence_intervals: [],
          freeze_intervals: [],
          frame_stats: [],
          content_profile: filters.motion ? "unknown" : "unknown (motion filter not enabled)",
        };

        const command = buildAnalysisCommand(ws.input, { ...filters, transcription: false }, ws.work);

        if (command !== null) {
          // Several filter combinations exit non-zero while still emitting
          // everything we need, so the log is parsed regardless of the code.
          const { log } = ws.exec(command.args);
          const meta = ws.exists(command.videoMetaFile) ? ws.readText(command.videoMetaFile) : "";

          if (filters.scene_changes) {
            analysis.scenes = meta ? parseScdetFromMetaFile(meta) : [];
            if (analysis.scenes.length === 0) analysis.scenes = parseScdetOutput(log);
          }
          if (filters.black_intervals) analysis.black_intervals = parseBlackdetectOutput(log);
          if (filters.silence) analysis.silence_intervals = parseSilenceOutput(log);
          if (filters.freeze) analysis.freeze_intervals = parseFreezeOutput(log);

          if (filters.loudness) {
            const loudness = parseEbur128Output(log);
            if (loudness !== undefined) analysis.loudness_summary = loudness;
          }

          if (filters.motion) {
            const siti = parseSitiOutput(log);
            analysis.content_profile = deriveContentProfile(siti.siAvg, siti.tiAvg);
          }

          if (filters.blur && meta) {
            for (const entry of parseBlurOutput(meta)) {
              const existing = analysis.frame_stats.find((f) => f.timestamp === entry.timestamp);
              if (existing) existing.blur = entry.blur;
              else analysis.frame_stats.push({ timestamp: entry.timestamp, blur: entry.blur });
            }
          }

          if (filters.exposure && meta) {
            for (const entry of parseSignalstatsOutput(meta)) {
              const existing = analysis.frame_stats.find((f) => f.timestamp === entry.timestamp);
              if (existing) {
                existing.brightness = entry.brightness;
                existing.saturation = entry.saturation;
              } else {
                analysis.frame_stats.push(entry);
              }
            }
          }

          analysis.frame_stats.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }

        const pcm = filters.transcription && metadata.has_audio ? extractPcm(ws) : null;

        return { metadata, analysis, pcm };
      });

      if (pcm) {
        const spec = resolveWhisperModel(config.whisper_model);
        const result = await transcribe(pcm, {
          spec,
          language: params.language ?? config.whisper_language,
        });
        analysis.transcription = result.transcription;
      }

      if (config.enable_index) {
        const sessionDir = getSessionDir(SESSIONS_DIR, videoPath);
        const manifest = loadManifest(sessionDir) ?? createManifest(computeVideoHash(videoPath), videoPath);
        manifest.analysis = analysis;
        saveManifest(sessionDir, manifest);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ metadata, analysis }, null, 2) }],
      };
    },
  );
}
