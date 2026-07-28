import { describe, it, expect } from "vitest";
import { parseProbeLog } from "../../src/extractors/frames.js";

// Verbatim output of `ffmpeg -hide_banner -i input.mp4` from @ffmpeg/core 0.12.10.
const H264_WITH_AUDIO = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/job0/input.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf62.12.102
  Duration: 00:00:10.00, start: 0.000000, bitrate: 119 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 640x480 [SAR 1:1 DAR 4:3], 41 kb/s, 25 fps, 25 tbr, 12800 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 16000 Hz, mono, fltp, 71 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified
Aborted()`;

describe("parseProbeLog", () => {
  it("reads duration, geometry, codec and fps", () => {
    const meta = parseProbeLog(H264_WITH_AUDIO, 149_613);

    expect(meta.duration_seconds).toBe(10);
    expect(meta.duration).toBe("00:00:10");
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(480);
    expect(meta.resolution).toBe("640x480");
    expect(meta.codec).toBe("h264");
    expect(meta.original_fps).toBe(25);
    expect(meta.has_audio).toBe(true);
    expect(meta.file_size).toBe("0.1MB");
  });

  it("keeps sub-second duration precision", () => {
    const meta = parseProbeLog(H264_WITH_AUDIO.replace("00:00:10.00", "01:02:03.45"), 0);

    expect(meta.duration_seconds).toBeCloseTo(3723.45, 2);
    expect(meta.duration).toBe("01:02:03");
  });

  it("detects the absence of an audio track", () => {
    const silent = H264_WITH_AUDIO.split("\n")
      .filter((line) => !line.includes("Audio:") && !line.includes("SoundHandler"))
      .join("\n");

    expect(parseProbeLog(silent, 0).has_audio).toBe(false);
  });

  it("ignores cover art and picks the real video track", () => {
    const withCoverArt = H264_WITH_AUDIO.replace(
      "  Stream #0:1[0x2](und): Audio:",
      "  Stream #0:2[0x3]: Video: mjpeg (Baseline), yuvj420p(pc), 120x120 [SAR 1:1 DAR 1:1], 90k tbr (attached pic)\n  Stream #0:1[0x2](und): Audio:",
    );
    const meta = parseProbeLog(withCoverArt, 0);

    expect(meta.codec).toBe("h264");
    expect(meta.width).toBe(640);
  });

  it("falls back to tbr when fps is missing", () => {
    const noFps = H264_WITH_AUDIO.replace(", 25 fps, 25 tbr,", ", 30 tbr,");

    expect(parseProbeLog(noFps, 0).original_fps).toBe(30);
  });

  it("reports zero duration when the container does not declare one", () => {
    const meta = parseProbeLog(H264_WITH_AUDIO.replace(/Duration: 00:00:10\.00/, "Duration: N/A"), 0);

    expect(meta.duration_seconds).toBe(0);
    expect(meta.width).toBe(640);
  });

  it("throws when there is no video stream at all", () => {
    const audioOnly = `Input #0, mp3, from '/job0/input.mp3':
  Duration: 00:03:20.00, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified`;

    expect(() => parseProbeLog(audioOnly, 0)).toThrow(/No video stream/);
  });
});
