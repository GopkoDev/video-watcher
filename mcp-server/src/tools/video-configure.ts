import { z } from "zod";
import { rmSync, existsSync } from "fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CONFIG_PATH, SESSIONS_DIR, loadConfig, saveConfig } from "../config.js";

export function registerVideoConfigure(server: McpServer): void {
  server.tool(
    "video_configure",
    "Change video perception preferences: whisper model size and language, frame format/resolution/fps, frame limits and the session cache.",
    {
      whisper_model: z
        .enum(["auto", "tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"])
        .optional()
        .describe("Whisper size; 'auto' picks one from installed RAM. Larger models download more and run slower, but transcribe non-English speech far better."),
      whisper_language: z.string().min(2).max(10).optional()
        .describe("ISO-639-1 code, or 'auto' to detect per video"),
      frame_format: z.enum(["jpeg", "png", "webp"]).optional(),
      frame_resolution: z.number().min(128).max(2048).optional(),
      default_fps: z.union([z.number().positive(), z.literal("auto")]).optional(),
      max_frames: z.number().min(1).max(1000).optional(),
      max_input_mb: z.number().min(16).max(8192).optional()
        .describe("Largest video that may be loaded into wasm memory"),
      enable_index: z.boolean().optional(),
      session_max_age_days: z.number().min(1).optional(),
      clear_sessions: z.boolean().optional().describe("Delete every cached session before applying changes"),
    },
    async (params) => {
      if (params.clear_sessions && existsSync(SESSIONS_DIR)) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }

      const updated = { ...loadConfig() };
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && key !== "clear_sessions") {
          (updated as Record<string, unknown>)[key] = value;
        }
      }

      saveConfig(updated);

      let text = `Configuration saved to ${CONFIG_PATH}:\n${JSON.stringify(updated, null, 2)}`;
      if (params.clear_sessions) text += "\n\nAll cached sessions were deleted.";

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
