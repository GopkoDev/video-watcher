import { readSync } from "fs";

/**
 * A window into a file on disk that looks enough like a `Blob` for Emscripten's
 * WORKERFS to accept it.
 *
 * WORKERFS only ever touches three things on the object it is given: `.size`,
 * `.slice(start, end)`, and — via `FileReaderSync` — the bytes behind a slice.
 * Satisfying exactly those lets ffmpeg read a video straight off disk instead of
 * receiving a full copy in wasm memory.
 */
export interface LazyChunk {
  readonly size: number;
  /** File descriptor the bytes come from; -1 for the empty placeholder. */
  readonly fd: number;
  /** Absolute offset of this window within the file. */
  readonly start: number;
  slice(from: number, to?: number): LazyChunk;
}

export function createLazyChunk(fd: number, size: number, start = 0): LazyChunk {
  return {
    fd,
    start,
    size,
    slice(from: number, to: number = size): LazyChunk {
      // WORKERFS asks for `slice(position, position + length)` and does not
      // clamp to the end of the file, so clamping happens here.
      const begin = Math.max(0, Math.min(from, size));
      const end = Math.max(begin, Math.min(to, size));
      return createLazyChunk(fd, end - begin, start + begin);
    },
  };
}

export const EMPTY_CHUNK: LazyChunk = createLazyChunk(-1, 0);

/**
 * WORKERFS reads through `new FileReaderSync()`, a Web Worker API that Node
 * does not have. The real one turns a Blob slice into an ArrayBuffer
 * synchronously; ours does the same for a `LazyChunk`, straight from the file
 * descriptor.
 *
 * Installing this globally is safe here: Node defines no `FileReaderSync`, and
 * transformers.js — the other library in this process — never references it.
 */
export function installFileReaderSync(): void {
  const globals = globalThis as Record<string, unknown>;
  if (typeof globals.FileReaderSync !== "undefined") return;

  globals.FileReaderSync = class NodeFileReaderSync {
    readAsArrayBuffer(chunk: LazyChunk): ArrayBuffer {
      const buffer = Buffer.allocUnsafe(chunk.size);
      if (chunk.size > 0 && chunk.fd >= 0) {
        readSync(chunk.fd, buffer, 0, chunk.size, chunk.start);
      }
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
  };
}

/**
 * Filenames offered by the lazy mount. ffmpeg detects containers by content, but
 * keeping a matching extension avoids the ambiguous cases, and the mount cannot
 * be reshaped later — this build of the core ships no `FS.unmount`, so the set of
 * names has to be fixed up front.
 */
export const LAZY_INPUT_NAMES = [
  "input.mp4",
  "input.mov",
  "input.mkv",
  "input.webm",
  "input.avi",
  "input.m4v",
  "input.mpg",
  "input.ts",
  "input.bin",
] as const;

export function lazyInputNameFor(extension: string): string {
  const candidate = `input${extension.toLowerCase()}`;
  return (LAZY_INPUT_NAMES as readonly string[]).includes(candidate) ? candidate : "input.bin";
}
