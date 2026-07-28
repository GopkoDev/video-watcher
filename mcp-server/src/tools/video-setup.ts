import { z } from "zod";
import { arch, platform } from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODELS_DIR, loadConfig } from "../config.js";
import { warmUpFFmpeg } from "../ffmpeg/core.js";
import { isModelCached, recommendWhisperModel, resolveWhisperModel, totalRamGb } from "../asr/models.js";
import { loadWhisper } from "../asr/whisper.js";

export function registerVideoSetup(server: McpServer): void {
  server.tool(
    "video_setup",
    "Report what the plugin will use on this machine and, with prefetch, download the whisper model up front. There is nothing to install: ffmpeg ships as WebAssembly and the model is fetched once from HuggingFace.",
    {
      prefetch: z.boolean().default(false)
        .describe("Load ffmpeg and download the whisper model now instead of on the first video"),
    },
    async ({ prefetch }) => {
      const config = loadConfig();
      const ramGb = totalRamGb();
      const spec = resolveWhisperModel(config.whisper_model, ramGb);
      const cachedBefore = isModelCached(spec);

      let prefetchNote = "";
      if (prefetch) {
        await warmUpFFmpeg();
        try {
          await loadWhisper(spec);
          prefetchNote = cachedBefore
            ? "\nffmpeg loaded; the model was already cached."
            : `\nffmpeg loaded and whisper-${spec.name} downloaded to ${MODELS_DIR}.`;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          prefetchNote = `\n**Model download failed:** ${detail}\nCheck your network connection and run video_setup again.`;
        }
      }

      const report = [
        "## Machine",
        `- Platform: ${platform()} ${arch()}`,
        `- Node: ${process.version}`,
        `- RAM: ${ramGb}GB`,
        "",
        "## Dependencies",
        "- ffmpeg: bundled as WebAssembly (@ffmpeg/core) — nothing to install",
        "- whisper: bundled via transformers.js — nothing to install",
        "",
        "## Whisper model",
        `- Setting: ${config.whisper_model}${config.whisper_model === "auto" ? ` (auto → ${recommendWhisperModel(ramGb)} for ${ramGb}GB RAM)` : ""}`,
        `- Model: ${spec.repo} (${spec.notes})`,
        `- Downloaded: ${isModelCached(spec) ? "yes" : `no — ~${spec.approx_download_mb}MB will be fetched on first use`}`,
        `- Cache: ${MODELS_DIR}`,
        `- Language: ${config.whisper_language}`,
        "",
        "## Status",
        isModelCached(spec)
          ? "Ready. Everything runs offline from here on."
          : "Ready. The first transcription downloads the model once, then everything runs offline.",
        prefetchNote,
      ].join("\n");

      return { content: [{ type: "text" as const, text: report.trimEnd() }] };
    },
  );
}
