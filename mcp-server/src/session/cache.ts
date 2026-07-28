import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { frameFormatExtension } from "../extractors/frames.js";
import type { Frame, FrameFormat } from "../types.js";

export function timestampToFilename(timestamp: string, format: FrameFormat): string {
  return `${timestamp.replace(/:/g, "-")}.${frameFormatExtension(format)}`;
}

/**
 * Writes frames into the session cache under stable, timestamp-derived names.
 *
 * The names must not depend on extraction order: ffmpeg numbers its output
 * `frame_0001…`, so reusing those names across calls would silently overwrite
 * cached frames from an earlier, different time range.
 */
export function cacheFrames(
  sessionDir: string,
  format: FrameFormat,
  resolution: number | string,
  frames: Frame[],
  skipExisting = true,
): Array<{ timestamp: string; file: string }> {
  const dir = join(sessionDir, "frames", format, String(resolution));
  mkdirSync(dir, { recursive: true });

  const entries: Array<{ timestamp: string; file: string }> = [];

  for (const frame of frames) {
    const file = join(dir, timestampToFilename(frame.timestamp, format));

    if (frame.image && !(skipExisting && existsSync(file))) {
      writeFileSync(file, Buffer.from(frame.image, "base64"));
    }

    frame.sourcePath = file;
    entries.push({ timestamp: frame.timestamp, file });
  }

  return entries;
}
