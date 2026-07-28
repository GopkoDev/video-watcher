import { describe, it, expect } from "vitest";
import { join } from "path";
import { withVideo } from "../../src/ffmpeg/workspace.js";
import { assertInputSize } from "../../src/ffmpeg/workspace.js";
import {
  calculateAutoFps,
  extractFrames,
  extractFramesBySegments,
  frameFormatExtension,
  frameFormatMimeType,
  probeVideo,
} from "../../src/extractors/frames.js";
import { extractPcm } from "../../src/extractors/audio.js";
import { SAMPLE_RATE } from "../../src/asr/whisper.js";
import type { Segment } from "../../src/types.js";

const FIXTURE = join(import.meta.dirname, "../fixtures/test-3s.mp4");
const MAX_BYTES = 512 * 1024 * 1024;

// The wasm core boots once per process; these all run against the same instance.
const TIMEOUT = 120_000;

describe("pure helpers", () => {
  it("scales auto fps down as videos get longer", () => {
    expect(calculateAutoFps(30)).toBe(2);
    expect(calculateAutoFps(120)).toBe(1);
    expect(calculateAutoFps(600)).toBe(0.5);
    expect(calculateAutoFps(1800)).toBe(0.2);
    expect(calculateAutoFps(7200)).toBe(0.1);
  });

  it("maps formats to extensions and mime types", () => {
    expect(frameFormatExtension("jpeg")).toBe("jpg");
    expect(frameFormatExtension("png")).toBe("png");
    expect(frameFormatExtension("webp")).toBe("webp");
    expect(frameFormatMimeType("jpeg")).toBe("image/jpeg");
    expect(frameFormatMimeType("png")).toBe("image/png");
  });

  it("refuses inputs larger than the memory budget", () => {
    expect(() => assertInputSize(200 * 1024 * 1024, 100 * 1024 * 1024, "/big.mp4")).toThrow(/exceeds/);
    expect(() => assertInputSize(50 * 1024 * 1024, 100 * 1024 * 1024, "/ok.mp4")).not.toThrow();
  });
});

describe("ffmpeg.wasm pipeline", () => {
  it("reads the source lazily off disk instead of copying it in", { timeout: TIMEOUT }, async () => {
    // A silent fallback to the in-memory path would still pass every other test
    // here, so assert the lazy mount is the one actually in use.
    const input = await withVideo(FIXTURE, MAX_BYTES, (ws) => ws.input);

    expect(input).toBe("/media/input.mp4");
  });

  it("ignores max_input_mb while reading lazily", { timeout: TIMEOUT }, async () => {
    // One byte of budget: enough to prove the size guard is not on this path.
    const meta = await withVideo(FIXTURE, 1, (ws) => probeVideo(ws));

    expect(meta.width).toBe(320);
  });

  it("probes metadata without any external binary", { timeout: TIMEOUT }, async () => {
    const meta = await withVideo(FIXTURE, MAX_BYTES, (ws) => probeVideo(ws));

    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.codec).toContain("h264");
    expect(meta.has_audio).toBe(true);
    expect(meta.duration_seconds).toBeCloseTo(3, 0);
    expect(meta.duration).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("extracts frames as base64 with absolute timestamps", { timeout: TIMEOUT }, async () => {
    const { frames, truncated } = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractFrames(ws, { fps: 1, resolution: 256, format: "jpeg", maxFrames: 100 }),
    );

    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0].timestamp).toBe("00:00:00");
    expect(frames[1].timestamp).toBe("00:00:01");
    expect(frames[0].format).toBe("jpeg");
    expect(frames[0].image!.length).toBeGreaterThan(100);
    expect(truncated).toBe(false);
  });

  it("honours png output", { timeout: TIMEOUT }, async () => {
    const { frames } = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractFrames(ws, { fps: 1, resolution: 128, format: "png", maxFrames: 10 }),
    );

    expect(frames[0].format).toBe("png");
    // PNG magic number, base64-encoded.
    expect(Buffer.from(frames[0].image!, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("reports truncation when max_frames cuts the range short", { timeout: TIMEOUT }, async () => {
    const { frames, truncated } = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractFrames(ws, { fps: 2, resolution: 128, format: "jpeg", maxFrames: 2 }),
    );

    expect(frames).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("keeps end_time absolute when start_time is set", { timeout: TIMEOUT }, async () => {
    // 00:00:01 → 00:00:03 at 1fps is a 2 second window, so 2 frames. A `-to`
    // based implementation would seek to 1s and then run for 3s instead.
    const { frames } = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractFrames(ws, {
        fps: 1,
        resolution: 128,
        format: "jpeg",
        startTime: "00:00:01",
        endTime: "00:00:03",
        maxFrames: 100,
      }),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0].timestamp).toBe("00:00:01");
    expect(frames[1].timestamp).toBe("00:00:02");
  });

  it("extracts segments at their own fps and resolution", { timeout: TIMEOUT }, async () => {
    const segments: Segment[] = [
      { start: "00:00:00", end: "00:00:02", fps: 1, resolution: 128 },
      { start: "00:00:02", end: "00:00:03", fps: 2, resolution: 256 },
    ];

    const frames = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractFramesBySegments(ws, segments, "jpeg", 512, 1000),
    );

    expect(frames.filter((f) => f.resolution === 128)).toHaveLength(2);
    expect(frames.filter((f) => f.resolution === 256).length).toBeGreaterThanOrEqual(2);
    expect(frames[0].timestamp).toBe("00:00:00");
  });

  it("decodes audio to 16kHz mono float samples", { timeout: TIMEOUT }, async () => {
    const pcm = await withVideo(FIXTURE, MAX_BYTES, (ws) => extractPcm(ws));

    expect(pcm).toBeInstanceOf(Float32Array);
    expect(pcm.length / SAMPLE_RATE).toBeCloseTo(3, 0);
    expect(pcm.every((sample) => sample >= -1.5 && sample <= 1.5)).toBe(true);
  });

  it("clips audio to the requested range", { timeout: TIMEOUT }, async () => {
    const pcm = await withVideo(FIXTURE, MAX_BYTES, (ws) =>
      extractPcm(ws, { startTime: "00:00:01", endTime: "00:00:02" }),
    );

    expect(pcm.length / SAMPLE_RATE).toBeCloseTo(1, 1);
  });

  it("fails loudly on a file ffmpeg cannot read", { timeout: TIMEOUT }, async () => {
    await expect(
      withVideo(join(import.meta.dirname, "../fixtures"), MAX_BYTES, (ws) => probeVideo(ws)),
    ).rejects.toThrow();
  });
});
