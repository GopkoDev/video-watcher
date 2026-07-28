import { describe, expect, it } from "vitest";
import {
  formatHMS,
  parseHMS,
  shiftAudioResult,
} from "../../src/utils/timestamps.js";
import type { AudioResult } from "../../src/types.js";

describe("parseHMS", () => {
  it("parses 00:00:00 as 0", () => {
    expect(parseHMS("00:00:00")).toBe(0);
  });

  it("parses hours, minutes, and seconds", () => {
    expect(parseHMS("01:02:03")).toBe(1 * 3600 + 2 * 60 + 3);
  });

  it("parses timestamps past an hour", () => {
    expect(parseHMS("02:30:45")).toBe(2 * 3600 + 30 * 60 + 45);
  });

  it("throws on malformed input", () => {
    expect(() => parseHMS("1:2")).toThrow(/Invalid HH:MM:SS/);
    expect(() => parseHMS("abc")).toThrow(/Invalid HH:MM:SS/);
    expect(() => parseHMS("")).toThrow(/Invalid HH:MM:SS/);
  });

  it("throws on non-numeric segments", () => {
    expect(() => parseHMS("00:0a:00")).toThrow(/Invalid HH:MM:SS/);
  });
});

describe("formatHMS", () => {
  it("formats 0 as 00:00:00", () => {
    expect(formatHMS(0)).toBe("00:00:00");
  });

  it("pads single-digit values", () => {
    expect(formatHMS(5)).toBe("00:00:05");
    expect(formatHMS(65)).toBe("00:01:05");
    expect(formatHMS(3665)).toBe("01:01:05");
  });

  it("truncates sub-second precision", () => {
    expect(formatHMS(5.7)).toBe("00:00:05");
    expect(formatHMS(65.9)).toBe("00:01:05");
  });

  it("clamps negative values to 00:00:00", () => {
    expect(formatHMS(-5)).toBe("00:00:00");
  });

  it("round-trips with parseHMS", () => {
    const samples = [0, 1, 59, 60, 3599, 3600, 7265];
    for (const s of samples) {
      expect(parseHMS(formatHMS(s))).toBe(s);
    }
  });
});

describe("shiftAudioResult", () => {
  const baseResult: AudioResult = {
    engine: "whisper",
    model: "onnx-community/whisper-base",
    language: "en",
    language_detected: true,
    transcription: [
      { start: "00:00:00", end: "00:00:05", text: "hello" },
      { start: "00:00:05", end: "00:00:10", text: "world" },
    ],
    full_text: "hello world",
  };

  it("returns the same reference when offset is zero", () => {
    expect(shiftAudioResult(baseResult, 0)).toBe(baseResult);
  });

  it("adds the offset to every transcription timestamp", () => {
    const shifted = shiftAudioResult(baseResult, 10);

    expect(shifted.transcription[0].start).toBe("00:00:10");
    expect(shifted.transcription[0].end).toBe("00:00:15");
    expect(shifted.transcription[1].start).toBe("00:00:15");
    expect(shifted.transcription[1].end).toBe("00:00:20");
  });

  it("preserves the transcript text", () => {
    expect(shiftAudioResult(baseResult, 10).transcription[0].text).toBe("hello");
  });

  it("handles minute-scale offsets", () => {
    const shifted = shiftAudioResult(baseResult, 125);

    expect(shifted.transcription[0].start).toBe("00:02:05");
    expect(shifted.transcription[1].end).toBe("00:02:15");
  });

  it("handles hour-scale offsets", () => {
    expect(shiftAudioResult(baseResult, 3625).transcription[0].start).toBe("01:00:25");
  });

  it("does not mutate the input", () => {
    const snapshot = JSON.stringify(baseResult);
    shiftAudioResult(baseResult, 42);

    expect(JSON.stringify(baseResult)).toBe(snapshot);
  });

  it("carries the provenance fields through the shift", () => {
    const shifted = shiftAudioResult(baseResult, 10);

    expect(shifted.engine).toBe("whisper");
    expect(shifted.model).toBe("onnx-community/whisper-base");
    expect(shifted.language).toBe("en");
    expect(shifted.language_detected).toBe(true);
    expect(shifted.full_text).toBe("hello world");
  });

  it("leaves a skipped result untouched", () => {
    const skipped: AudioResult = {
      engine: "none",
      model: null,
      language: null,
      language_detected: false,
      transcription: [],
      full_text: "",
      skipped_reason: "video has no audio track",
    };

    expect(shiftAudioResult(skipped, 60).skipped_reason).toBe("video has no audio track");
  });
});
