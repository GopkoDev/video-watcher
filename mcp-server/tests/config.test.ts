import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, saveConfig, defaultConfig } from "../src/config.js";

const TEST_DIR = join(tmpdir(), "cvv-config-test-" + Date.now());
const CONFIG_PATH = join(TEST_DIR, "config.json");

describe("config", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns defaults when no file exists", () => {
    const config = loadConfig(CONFIG_PATH);

    expect(config.whisper_model).toBe("auto");
    expect(config.whisper_language).toBe("auto");
    expect(config.frame_format).toBe("jpeg");
    expect(config.frame_resolution).toBe(512);
    expect(config.default_fps).toBe("auto");
    expect(config.max_frames).toBe(100);
    expect(config.max_input_mb).toBe(1024);
    expect(config.enable_index).toBe(false);
    expect(config.session_max_age_days).toBe(7);
  });

  it("round-trips a saved config", () => {
    saveConfig({ ...defaultConfig, whisper_model: "small", frame_resolution: 768 }, CONFIG_PATH);
    const loaded = loadConfig(CONFIG_PATH);

    expect(loaded.whisper_model).toBe("small");
    expect(loaded.frame_resolution).toBe(768);
  });

  it("merges a partial config over the defaults", () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ whisper_language: "uk" }));
    const loaded = loadConfig(CONFIG_PATH);

    expect(loaded.whisper_language).toBe("uk");
    expect(loaded.frame_format).toBe("jpeg");
    expect(loaded.max_frames).toBe(100);
  });

  it("falls back to defaults when the file is not valid JSON", () => {
    writeFileSync(CONFIG_PATH, "{ not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    const loaded = loadConfig(CONFIG_PATH);

    expect(loaded).toEqual(defaultConfig);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("creates the directory when saving", () => {
    const nested = join(TEST_DIR, "a", "b", "config.json");
    saveConfig(defaultConfig, nested);

    expect(loadConfig(nested)).toEqual(defaultConfig);
  });
});
