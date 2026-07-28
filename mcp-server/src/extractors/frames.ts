import type { VideoWorkspace } from "../ffmpeg/workspace.js";
import type { Frame, FrameFormat, Segment, VideoMetadata } from "../types.js";
import { formatHMS, parseHMS } from "../utils/timestamps.js";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * Reads the stream summary that ffmpeg prints when it is given an input and no
 * output. The run costs nothing — ffmpeg parses the header, complains that no
 * output was specified, and exits.
 *
 * ffprobe is deliberately not used: this wasm build shares one instance across
 * calls, and once `ffprobe()` has run on it every later `exec()` aborts. Since
 * the plugin needs metadata *and* frames from the same instance, metadata has
 * to come from ffmpeg itself.
 */
export function parseProbeLog(log: string, fileSizeBytes: number): VideoMetadata {
  const durationMatch = log.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * 3600 +
      Number(durationMatch[2]) * 60 +
      Number(durationMatch[3]) +
      Number(`0.${durationMatch[4]}`)
    : 0;

  const streamLines = log.split("\n").filter((line) => /^\s*Stream #\d+:\d+/.test(line));
  const videoLines = streamLines.filter((line) => /:\s*Video:/.test(line));
  // Cover art is muxed in as a one-frame video stream; the real track wins.
  const videoLine = videoLines.find((line) => !line.includes("attached pic")) ?? videoLines[0];

  if (!videoLine) {
    throw new Error(`No video stream found in this file.\n${log.split("\n").slice(-6).join("\n")}`);
  }

  const dimensions = videoLine.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const width = dimensions ? Number(dimensions[1]) : 0;
  const height = dimensions ? Number(dimensions[2]) : 0;

  const codec = videoLine.match(/:\s*Video:\s*([A-Za-z0-9_]+)/)?.[1] ?? "unknown";
  // Prefer the reported frame rate, falling back to the container's tbr.
  const fps = videoLine.match(/,\s*([\d.]+)\s*fps\b/)?.[1] ?? videoLine.match(/,\s*([\d.]+)\s*tbr\b/)?.[1];

  return {
    duration: formatHMS(durationSeconds),
    duration_seconds: durationSeconds,
    resolution: `${width}x${height}`,
    width,
    height,
    codec,
    original_fps: fps ? Math.round(Number(fps)) : 0,
    file_size: `${(fileSizeBytes / (1024 * 1024)).toFixed(1)}MB`,
    has_audio: streamLines.some((line) => /:\s*Audio:/.test(line)),
  };
}

export function probeVideo(ws: VideoWorkspace): VideoMetadata {
  const { log } = ws.exec(["-hide_banner", "-i", ws.input]);
  return parseProbeLog(log, ws.inputSize);
}

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

export function calculateAutoFps(durationSeconds: number): number {
  if (durationSeconds < 60) return 2;
  if (durationSeconds < 300) return 1;
  if (durationSeconds < 900) return 0.5;
  if (durationSeconds < 3600) return 0.2;
  return 0.1;
}

export function frameFormatExtension(format: FrameFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function frameFormatMimeType(format: FrameFormat): string {
  return `image/${format}`;
}

function frameQualityArgs(format: FrameFormat): string[] {
  if (format === "jpeg") return ["-q:v", "5"];
  if (format === "webp") return ["-quality", "80"];
  return [];
}

export interface ExtractFramesOptions {
  fps: number;
  resolution: number;
  format: FrameFormat;
  startTime?: string;
  endTime?: string;
  maxFrames: number;
  /** Sub-directory name inside the workspace scratch dir. */
  outputName?: string;
}

/**
 * Builds the ffmpeg argv for one extraction pass.
 *
 * `-ss` is an input option (fast seek) while `-to` would be measured from the
 * seek point rather than from the start of the file, so a range is expressed as
 * an explicit `-t <duration>` instead. That keeps `end_time` absolute, which is
 * what every caller means by it.
 */
export function buildFrameArgs(
  input: string,
  outputPattern: string,
  options: ExtractFramesOptions,
): string[] {
  const args: string[] = ["-hide_banner"];
  const startSeconds = options.startTime ? parseHMS(options.startTime) : 0;

  if (options.startTime) {
    args.push("-ss", options.startTime);
  }

  args.push("-i", input);

  if (options.endTime) {
    const duration = parseHMS(options.endTime) - startSeconds;
    if (duration <= 0) {
      throw new Error(`end_time (${options.endTime}) must be after start_time (${options.startTime ?? "00:00:00"}).`);
    }
    args.push("-t", String(duration));
  }

  args.push(
    "-vf", `fps=${options.fps},scale=${options.resolution}:-1`,
    "-frames:v", String(options.maxFrames),
    ...frameQualityArgs(options.format),
    "-y",
    outputPattern,
  );

  return args;
}

export interface ExtractedFrames {
  frames: Frame[];
  /** True when maxFrames cut the range short. */
  truncated: boolean;
}

export function extractFrames(ws: VideoWorkspace, options: ExtractFramesOptions): ExtractedFrames {
  const extension = frameFormatExtension(options.format);
  const dir = ws.mkdir(options.outputName ?? `frames-${Math.round(options.resolution)}-${options.fps}`);
  const args = buildFrameArgs(ws.input, `${dir}/frame_%04d.${extension}`, options);

  const result = ws.exec(args);
  const files = ws.list(dir)
    .filter((f) => f.startsWith("frame_") && f.endsWith(`.${extension}`))
    .sort();

  if (files.length === 0) {
    throw new Error(`ffmpeg produced no frames (exit ${result.code}).\n${tailLog(result.log)}`);
  }

  const offsetSeconds = options.startTime ? parseHMS(options.startTime) : 0;

  const frames: Frame[] = files.map((file, index) => ({
    timestamp: formatHMS(offsetSeconds + index / options.fps),
    image: Buffer.from(ws.readFile(`${dir}/${file}`)).toString("base64"),
    format: options.format,
  }));

  return { frames, truncated: files.length >= options.maxFrames };
}

export interface SegmentFrame extends Frame {
  resolution: number;
}

export function extractFramesBySegments(
  ws: VideoWorkspace,
  segments: Segment[],
  format: FrameFormat,
  defaultResolution: number,
  maxFramesPerSegment: number,
): SegmentFrame[] {
  const all: SegmentFrame[] = [];

  segments.forEach((segment, index) => {
    const resolution = segment.resolution ?? defaultResolution;
    const { frames } = extractFrames(ws, {
      fps: segment.fps,
      resolution,
      format,
      startTime: segment.start,
      endTime: segment.end,
      maxFrames: maxFramesPerSegment,
      outputName: `segment-${index}`,
    });

    for (const frame of frames) {
      all.push({ ...frame, resolution });
    }
  });

  return all;
}

function tailLog(log: string, lines = 12): string {
  return log.split("\n").slice(-lines).join("\n");
}
