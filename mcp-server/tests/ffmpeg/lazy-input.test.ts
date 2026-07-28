import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  EMPTY_CHUNK,
  LAZY_INPUT_NAMES,
  createLazyChunk,
  installFileReaderSync,
  lazyInputNameFor,
} from "../../src/ffmpeg/lazy-input.js";

const DIR = join(tmpdir(), "cvv-lazy-test-" + Date.now());
const FILE = join(DIR, "bytes.bin");
const CONTENT = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");

let fd: number;

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, CONTENT);
  fd = openSync(FILE, "r");
});

afterAll(() => {
  closeSync(fd);
  rmSync(DIR, { recursive: true, force: true });
});

describe("createLazyChunk", () => {
  it("describes the whole file up front", () => {
    const chunk = createLazyChunk(fd, CONTENT.length);

    expect(chunk.size).toBe(CONTENT.length);
    expect(chunk.start).toBe(0);
  });

  it("slices into an absolute window", () => {
    const slice = createLazyChunk(fd, CONTENT.length).slice(10, 20);

    expect(slice.start).toBe(10);
    expect(slice.size).toBe(10);
  });

  it("slices relative to the parent window", () => {
    const nested = createLazyChunk(fd, CONTENT.length).slice(10, 30).slice(5, 8);

    expect(nested.start).toBe(15);
    expect(nested.size).toBe(3);
  });

  it("clamps a read past the end of the file", () => {
    // WORKERFS asks for `slice(position, position + length)` without clamping.
    const slice = createLazyChunk(fd, CONTENT.length).slice(30, 1000);

    expect(slice.start).toBe(30);
    expect(slice.size).toBe(CONTENT.length - 30);
  });

  it("yields an empty window when the range is inverted or past the end", () => {
    const chunk = createLazyChunk(fd, CONTENT.length);

    expect(chunk.slice(20, 10).size).toBe(0);
    expect(chunk.slice(500, 600).size).toBe(0);
  });

  it("defaults the end of a slice to the end of the window", () => {
    expect(createLazyChunk(fd, CONTENT.length).slice(30).size).toBe(6);
  });
});

describe("FileReaderSync shim", () => {
  it("reads exactly the bytes a chunk points at", () => {
    installFileReaderSync();
    const reader = new (globalThis as any).FileReaderSync();
    const chunk = createLazyChunk(fd, CONTENT.length).slice(10, 20);

    const bytes = Buffer.from(reader.readAsArrayBuffer(chunk));

    expect(bytes.toString()).toBe("abcdefghij");
    expect(bytes).toHaveLength(10);
  });

  it("reads the whole file when given the full window", () => {
    installFileReaderSync();
    const reader = new (globalThis as any).FileReaderSync();

    const bytes = Buffer.from(reader.readAsArrayBuffer(createLazyChunk(fd, CONTENT.length)));

    expect(bytes.equals(CONTENT)).toBe(true);
  });

  it("returns nothing for the placeholder chunk", () => {
    installFileReaderSync();
    const reader = new (globalThis as any).FileReaderSync();

    expect(reader.readAsArrayBuffer(EMPTY_CHUNK).byteLength).toBe(0);
  });

  it("is installed only once", () => {
    installFileReaderSync();
    const first = (globalThis as any).FileReaderSync;
    installFileReaderSync();

    expect((globalThis as any).FileReaderSync).toBe(first);
  });
});

describe("lazyInputNameFor", () => {
  it("keeps a known container extension", () => {
    expect(lazyInputNameFor(".mp4")).toBe("input.mp4");
    expect(lazyInputNameFor(".mkv")).toBe("input.mkv");
    expect(lazyInputNameFor(".webm")).toBe("input.webm");
  });

  it("is case-insensitive", () => {
    expect(lazyInputNameFor(".MOV")).toBe("input.mov");
  });

  it("falls back to a generic name for anything else", () => {
    // The mount cannot grow later, so unknown extensions share one slot and
    // rely on ffmpeg detecting the container by content.
    expect(lazyInputNameFor(".flv")).toBe("input.bin");
    expect(lazyInputNameFor("")).toBe("input.bin");
  });

  it("only ever returns a name the mount actually provides", () => {
    for (const extension of [".mp4", ".mov", ".flv", ".ogv", ""]) {
      expect(LAZY_INPUT_NAMES).toContain(lazyInputNameFor(extension) as never);
    }
  });
});
