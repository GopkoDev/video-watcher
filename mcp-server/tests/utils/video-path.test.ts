import { describe, it, expect } from "vitest";
import { join } from "path";
import { homedir, tmpdir } from "os";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { resolveVideoPath } from "../../src/utils/video-path.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");

describe("resolveVideoPath", () => {
  it("resolves an existing file to an absolute path", () => {
    expect(resolveVideoPath(FIXTURE)).toBe(FIXTURE);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveVideoPath(`  ${FIXTURE}  `)).toBe(FIXTURE);
  });

  it("expands ~ because there is no shell in between", () => {
    // Claude passes user-written paths through verbatim.
    expect(() => resolveVideoPath("~/definitely-not-here-9f3a.mp4")).toThrow(
      new RegExp(`File not found: ${homedir()}`),
    );
  });

  it("rejects remote URLs with an actionable message", () => {
    expect(() => resolveVideoPath("https://youtube.com/watch?v=x")).toThrow(/Only local files/);
    expect(() => resolveVideoPath("s3://bucket/clip.mp4")).toThrow(/Only local files/);
  });

  it("rejects a missing file", () => {
    expect(() => resolveVideoPath("/nope/missing.mp4")).toThrow(/File not found/);
  });

  it("rejects a directory", () => {
    const dir = join(tmpdir(), "cvv-path-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    try {
      expect(() => resolveVideoPath(dir)).toThrow(/Not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a relative path", () => {
    const dir = join(tmpdir(), "cvv-rel-test-" + Date.now());
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "clip.mp4");
    writeFileSync(file, "not really a video");
    const previous = process.cwd();
    try {
      process.chdir(dir);
      // macOS resolves $TMPDIR through a symlink, so compare against the real path.
      expect(resolveVideoPath("clip.mp4")).toBe(join(realpathSync(dir), "clip.mp4"));
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
