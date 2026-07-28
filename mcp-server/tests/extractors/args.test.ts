import { describe, it, expect } from "vitest";
import { buildFrameArgs } from "../../src/extractors/frames.js";
import { buildAudioArgs } from "../../src/extractors/audio.js";

const frameOptions = {
  fps: 1,
  resolution: 512,
  format: "jpeg" as const,
  maxFrames: 100,
};

describe("buildFrameArgs", () => {
  it("puts -ss before -i so the seek is cheap", () => {
    const args = buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", { ...frameOptions, startTime: "00:10:00" });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  it("omits -ss when no start time is given", () => {
    const args = buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", frameOptions);
    expect(args).not.toContain("-ss");
  });

  it("expresses a range as -t duration, never -to", () => {
    // -to would be measured from the seek point, which would silently extend
    // the range past end_time whenever start_time is set.
    const args = buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", {
      ...frameOptions,
      startTime: "00:00:05",
      endTime: "00:00:10",
    });
    expect(args).not.toContain("-to");
    expect(args[args.indexOf("-t") + 1]).toBe("5");
  });

  it("uses the absolute end time when there is no start time", () => {
    const args = buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", { ...frameOptions, endTime: "00:00:42" });
    expect(args[args.indexOf("-t") + 1]).toBe("42");
  });

  it("rejects an end time at or before the start time", () => {
    expect(() =>
      buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", {
        ...frameOptions,
        startTime: "00:00:10",
        endTime: "00:00:05",
      }),
    ).toThrow(/must be after/);
  });

  it("carries fps, scale and the frame cap into the filter chain", () => {
    const args = buildFrameArgs("/in.mp4", "/out/f_%04d.jpg", { ...frameOptions, fps: 0.5, resolution: 256 });
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=0.5,scale=256:-1");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("100");
  });

  it("applies format-specific quality flags", () => {
    expect(buildFrameArgs("/in.mp4", "/o.jpg", frameOptions)).toContain("-q:v");
    expect(buildFrameArgs("/in.mp4", "/o.webp", { ...frameOptions, format: "webp" })).toContain("-quality");
    expect(buildFrameArgs("/in.mp4", "/o.png", { ...frameOptions, format: "png" })).not.toContain("-q:v");
  });
});

describe("buildAudioArgs", () => {
  it("decodes to 16kHz mono float PCM", () => {
    const args = buildAudioArgs("/in.mp4", "/out.f32", {});
    expect(args[args.indexOf("-ar") + 1]).toBe("16000");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
    expect(args[args.indexOf("-f") + 1]).toBe("f32le");
    expect(args).toContain("-vn");
  });

  it("uses the same seek/range shape as frame extraction", () => {
    const args = buildAudioArgs("/in.mp4", "/out.f32", { startTime: "00:00:05", endTime: "00:00:10" });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("-to");
    expect(args[args.indexOf("-t") + 1]).toBe("5");
  });

  it("rejects an inverted range", () => {
    expect(() => buildAudioArgs("/in.mp4", "/o.f32", { startTime: "00:01:00", endTime: "00:00:30" })).toThrow(
      /must be after/,
    );
  });
});
