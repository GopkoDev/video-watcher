import type { VideoWorkspace } from "../ffmpeg/workspace.js";
import { SAMPLE_RATE } from "../asr/whisper.js";
import { parseHMS } from "../utils/timestamps.js";

export interface ExtractAudioOptions {
  startTime?: string;
  endTime?: string;
}

/**
 * Decodes straight to headerless 32-bit float PCM at whisper's sample rate, so
 * the result can be handed to the model without a WAV parser in between.
 *
 * The seek/range flags mirror `buildFrameArgs` exactly — same `-ss` placement,
 * same explicit `-t` — so frames and transcript always describe the same span
 * of the video.
 */
export function buildAudioArgs(
  input: string,
  outputPath: string,
  options: ExtractAudioOptions,
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
    "-vn",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-f", "f32le",
    "-acodec", "pcm_f32le",
    "-y",
    outputPath,
  );

  return args;
}

export function extractPcm(ws: VideoWorkspace, options: ExtractAudioOptions = {}): Float32Array {
  const outPath = `${ws.work}/audio.f32`;
  const result = ws.exec(buildAudioArgs(ws.input, outPath, options));

  if (!ws.exists(outPath)) {
    throw new Error(`Could not decode audio (ffmpeg exit ${result.code}).\n${result.log.split("\n").slice(-12).join("\n")}`);
  }

  const bytes = ws.readFile(outPath);
  // MEMFS hands back a view into wasm memory whose offset is not guaranteed to
  // be 4-byte aligned, so copy before reinterpreting it as floats.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}
