import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { withVideo } from "../ffmpeg/workspace.js";
import { probeVideo } from "../extractors/frames.js";
import { resolveVideoPath } from "../utils/video-path.js";

export function registerVideoInfo(server: McpServer): void {
  server.tool(
    "video_info",
    "Get metadata about a local video file without processing it: duration, resolution, codec, frame rate, file size and whether it has audio.",
    { path: z.string().describe("Path to a local video file (~ is expanded)") },
    async ({ path }) => {
      const config = loadConfig();
      const videoPath = resolveVideoPath(path);
      const metadata = await withVideo(videoPath, config.max_input_mb * 1024 * 1024, (ws) => probeVideo(ws));

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ path: videoPath, ...metadata }, null, 2) }],
      };
    },
  );
}
