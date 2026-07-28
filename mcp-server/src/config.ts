import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { Config } from "./types.js";

export const CONFIG_DIR = join(homedir(), ".claude-video-vision");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const MODELS_DIR = join(CONFIG_DIR, "models");
export const SESSIONS_DIR = join(CONFIG_DIR, "sessions");

export const defaultConfig: Config = {
  whisper_model: "auto",
  whisper_language: "auto",
  frame_format: "jpeg",
  frame_resolution: 512,
  default_fps: "auto",
  max_frames: 100,
  max_input_mb: 1024,
  enable_index: false,
  session_max_age_days: 7,
};

export function loadConfig(configPath: string = CONFIG_PATH): Config {
  if (!existsSync(configPath)) {
    return { ...defaultConfig };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return { ...defaultConfig, ...raw };
  } catch (error) {
    // A hand-edited config should never take the whole server down; fall back
    // to defaults and say so on stderr.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[cvv] Ignoring unreadable config at ${configPath}: ${detail}`);
    return { ...defaultConfig };
  }
}

export function saveConfig(config: Config, configPath: string = CONFIG_PATH): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
