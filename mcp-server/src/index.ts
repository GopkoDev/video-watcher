#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerVideoWatch } from "./tools/video-watch.js";
import { registerVideoInfo } from "./tools/video-info.js";
import { registerVideoSetup } from "./tools/video-setup.js";
import { registerVideoConfigure } from "./tools/video-configure.js";
import { registerVideoAnalyze } from "./tools/video-analyze.js";
import { registerVideoDetail } from "./tools/video-detail.js";
import { SESSIONS_DIR, loadConfig } from "./config.js";
import { cleanExpiredSessions } from "./session/manager.js";

// stdout is the MCP transport: a stray console.log from any dependency would
// corrupt the JSON-RPC stream, so route it to stderr instead.
console.log = (...args: unknown[]) => console.error(...args);

const server = new McpServer({
  name: "video-watcher",
  version: "2.1.0",
});

registerVideoWatch(server);
registerVideoInfo(server);
registerVideoSetup(server);
registerVideoConfigure(server);
registerVideoAnalyze(server);
registerVideoDetail(server);

const config = loadConfig();
if (config.enable_index) {
  cleanExpiredSessions(SESSIONS_DIR, config.session_max_age_days);
}

const transport = new StdioServerTransport();
await server.connect(transport);
