// The choice between lazy and copied input is made once per process, so this
// file forces the fallback before anything imports the ffmpeg core. Vitest gives
// each test file its own module registry, which keeps it isolated from the lazy
// path exercised in pipeline.test.ts.
process.env.CVV_DISABLE_LAZY_INPUT = "1";

import { describe, it, expect } from "vitest";
import { join } from "path";
import { statSync } from "fs";
import { withVideo, assertInputSize } from "../../src/ffmpeg/workspace.js";
import { extractFrames, probeVideo } from "../../src/extractors/frames.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");
const TIMEOUT = 120_000;

describe("in-memory fallback", () => {
  it("copies the file into wasm memory when lazy access is disabled", { timeout: TIMEOUT }, async () => {
    const input = await withVideo(FIXTURE, 512 * 1024 * 1024, (ws) => ws.input);

    expect(input.startsWith("/media/")).toBe(false);
    expect(input).toMatch(/^\/job\d+\/input\.mp4$/);
  });

  it("produces the same frames as the lazy path", { timeout: TIMEOUT }, async () => {
    const { meta, frames } = await withVideo(FIXTURE, 512 * 1024 * 1024, (ws) => ({
      meta: probeVideo(ws),
      frames: extractFrames(ws, { fps: 1, resolution: 256, format: "jpeg", maxFrames: 100 }).frames,
    }));

    expect(meta.width).toBe(320);
    expect(meta.has_audio).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0].timestamp).toBe("00:00:00");
    expect(frames[1].timestamp).toBe("00:00:01");
  });

  it("enforces max_input_mb on this path", { timeout: TIMEOUT }, async () => {
    const size = statSync(FIXTURE).size;

    await expect(withVideo(FIXTURE, Math.floor(size / 2), (ws) => ws.input)).rejects.toThrow(/exceeds/);
  });

  it("explains the limit in terms the caller can act on", () => {
    expect(() => assertInputSize(200 * 1024 * 1024, 100 * 1024 * 1024, "/big.mp4")).toThrow(
      /max_input_mb/,
    );
  });
});
