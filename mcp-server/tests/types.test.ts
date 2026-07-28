import { describe, it, expect } from "vitest";
import type {
  AnalysisFilters,
  AudioResult,
  Segment,
  SessionManifest,
  VideoAnalysis,
} from "../src/types.js";

describe("types", () => {
  it("AnalysisFilters carries one flag per ffmpeg filter", () => {
    const filters: AnalysisFilters = {
      scene_changes: true,
      black_intervals: false,
      silence: true,
      freeze: false,
      motion: false,
      blur: false,
      exposure: false,
      loudness: false,
      transcription: true,
    };

    expect(Object.keys(filters)).toHaveLength(9);
  });

  it("SessionManifest keys frames by resolution and format", () => {
    const manifest: SessionManifest = {
      video_hash: "abc123",
      video_path: "/test.mp4",
      created_at: "2026-04-25T00:00:00Z",
      resolutions: {
        "512/jpeg": { frames: [{ timestamp: "00:00:02", file: "/cache/512/00-00-02.jpg" }] },
      },
    };

    expect(manifest.resolutions["512/jpeg"].frames).toHaveLength(1);
  });

  it("VideoAnalysis holds every analysis result", () => {
    const analysis: VideoAnalysis = {
      scenes: [{ time: "00:01:23", score: 64.3 }],
      black_intervals: [],
      silence_intervals: [{ start: "00:05:00", end: "00:05:03", duration: 3.0 }],
      freeze_intervals: [],
      frame_stats: [{ timestamp: "00:00:01", blur: 12.5, brightness: 130 }],
      loudness_summary: { mean_lufs: -18.4, range_lu: 6.2 },
      content_profile: "low visual complexity, low motion",
    };

    expect(analysis.scenes[0].score).toBe(64.3);
    expect(analysis.loudness_summary!.mean_lufs).toBeCloseTo(-18.4);
  });

  it("Segment defines a range with its own fps and optional resolution", () => {
    const segment: Segment = { start: "00:00:00", end: "00:01:00", fps: 2, resolution: 1024 };
    expect(segment.resolution).toBe(1024);
  });

  it("AudioResult records which model and language produced the transcript", () => {
    const result: AudioResult = {
      engine: "whisper",
      model: "onnx-community/whisper-base",
      language: "uk",
      language_detected: true,
      transcription: [{ start: "00:00:00", end: "00:00:03", text: "привіт" }],
      full_text: "привіт",
    };

    expect(result.engine).toBe("whisper");
    expect(result.language_detected).toBe(true);
    expect(result.skipped_reason).toBeUndefined();
  });
});
