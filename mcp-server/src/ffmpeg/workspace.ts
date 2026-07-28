import { readFileSync, statSync } from "fs";
import { extname } from "path";
import { withFFmpegJob, type FFmpegExecResult } from "./core.js";

export interface VideoWorkspace {
  /** MEMFS path of the source video inside the wasm filesystem. */
  readonly input: string;
  /** Size of the source file on the host, in bytes. */
  readonly inputSize: number;
  /** MEMFS scratch directory for outputs. */
  readonly work: string;
  exec(args: string[]): FFmpegExecResult;
  mkdir(name: string): string;
  readFile(path: string): Uint8Array;
  readText(path: string): string;
  list(path: string): string[];
  exists(path: string): boolean;
}

/**
 * Guards the fallback path only.
 *
 * When ffmpeg can read the file lazily off disk, size does not matter. When it
 * cannot, the whole file has to be copied into wasm memory — and peak RSS runs
 * to roughly 3.5x the file size — so an oversized input is refused up front
 * instead of failing somewhere inside the decoder.
 */
export function assertInputSize(bytes: number, maxBytes: number, hostPath: string): void {
  if (bytes <= maxBytes) return;
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)}MB`;
  throw new Error(
    `Video is ${mb(bytes)}, which exceeds the ${mb(maxBytes)} limit for in-memory processing (${hostPath}). ` +
      `Lazy file access is unavailable on this setup, so ffmpeg must hold the whole file in RAM. ` +
      `Raise max_input_mb with video_configure if you have the memory, or trim the file first.`,
  );
}

/**
 * Opens an exclusive ffmpeg job with `hostPath` visible inside the wasm
 * filesystem, runs `fn`, and tears the job down afterwards. All ffmpeg work for
 * one tool call should happen inside a single `withVideo` scope.
 *
 * The file is normally read lazily off disk. If that is unavailable it is copied
 * into wasm memory instead, which is where `maxInputBytes` starts to matter.
 *
 * Note that the whole callback holds the global ffmpeg lock — keep expensive
 * non-ffmpeg work (model inference) outside of it.
 */
export function withVideo<T>(
  hostPath: string,
  maxInputBytes: number,
  fn: (ws: VideoWorkspace) => Promise<T> | T,
): Promise<T> {
  const size = statSync(hostPath).size;
  const extension = extname(hostPath) || ".mp4";

  return withFFmpegJob(async (job) => {
    let input = job.mountHostFile(hostPath, extension);

    if (input === null) {
      assertInputSize(size, maxInputBytes, hostPath);
      input = job.writeFile(`input${extension}`, new Uint8Array(readFileSync(hostPath)));
    }

    const work = job.mkdir("work");

    const ws: VideoWorkspace = {
      input,
      inputSize: size,
      work,
      exec: (args) => job.exec(args),
      mkdir: (name) => job.mkdir(`work/${name}`),
      readFile: (path) => job.readFile(path),
      readText: (path) => job.readText(path),
      list: (path) => job.list(path),
      exists: (path) => job.exists(path),
    };

    return fn(ws);
  });
}
