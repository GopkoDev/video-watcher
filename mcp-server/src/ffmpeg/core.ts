import { createRequire } from "module";
import { closeSync, fstatSync, openSync, readFileSync } from "fs";
import { dirname, join } from "path";
import {
  EMPTY_CHUNK,
  LAZY_INPUT_NAMES,
  createLazyChunk,
  installFileReaderSync,
  lazyInputNameFor,
} from "./lazy-input.js";

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Emscripten core typings (only what we actually touch)
// ---------------------------------------------------------------------------

interface EmscriptenStat {
  mode: number;
}

/** Node in the wasm filesystem. Only WORKERFS nodes are mutated by hand. */
interface EmscriptenNode {
  size: number;
  contents: unknown;
}

interface EmscriptenFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string, opts?: { encoding?: "utf8" | "binary" }): Uint8Array;
  readdir(path: string): string[];
  mkdir(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  stat(path: string): EmscriptenStat;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  analyzePath(path: string): { exists: boolean };
  mount(type: unknown, opts: Record<string, unknown>, mountpoint: string): void;
  lookupPath(path: string): { node: EmscriptenNode };
  filesystems: Record<string, unknown>;
}

interface FFmpegCore {
  exec(...args: string[]): void;
  ffprobe(...args: string[]): void;
  reset(): void;
  setLogger(cb: (entry: { type: string; message: string }) => void): void;
  setTimeout(ms: number): void;
  ret: number;
  FS: EmscriptenFS;
}

// ---------------------------------------------------------------------------
// Core loading
// ---------------------------------------------------------------------------

/**
 * `@ffmpeg/core` ships an Emscripten build compiled for the *web worker*
 * environment — `ENVIRONMENT_IS_WORKER` is baked in as `true` and the module
 * dereferences `self.location.href` during initialisation. Node has neither
 * global, so we install them for the duration of the load and restore the
 * previous values afterwards.
 *
 * Restoring matters: `@huggingface/transformers` decides whether it runs in a
 * browser by checking `typeof self !== "undefined"`, and a leaked `self` would
 * make it look for browser caches and a WebGPU backend instead of
 * onnxruntime-node.
 */
function loadCoreFactory(coreDir: string): (opts: Record<string, unknown>) => Promise<FFmpegCore> {
  const globals = globalThis as Record<string, unknown>;
  const hadSelf = "self" in globals;
  const hadLocation = "location" in globals;
  const prevSelf = globals.self;
  const prevLocation = globals.location;

  if (!hadSelf) globals.self = globals;
  if (!hadLocation) globals.location = { href: `file://${coreDir}/` };

  try {
    return nodeRequire("@ffmpeg/core") as (opts: Record<string, unknown>) => Promise<FFmpegCore>;
  } finally {
    if (hadSelf) globals.self = prevSelf;
    else delete globals.self;
    if (hadLocation) globals.location = prevLocation;
    else delete globals.location;
  }
}

let corePromise: Promise<FFmpegCore> | null = null;

async function getCore(): Promise<FFmpegCore> {
  if (corePromise) return corePromise;

  corePromise = (async () => {
    const coreDir = dirname(nodeRequire.resolve("@ffmpeg/core"));
    const factory = loadCoreFactory(coreDir);

    // Hand the wasm bytes over directly so the module never tries to fetch or
    // XHR them — that path does not exist in Node.
    const wasm = readFileSync(join(coreDir, "ffmpeg-core.wasm"));
    const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);

    const globals = globalThis as Record<string, unknown>;
    const hadSelf = "self" in globals;
    const hadLocation = "location" in globals;
    const prevSelf = globals.self;
    const prevLocation = globals.location;
    if (!hadSelf) globals.self = globals;
    if (!hadLocation) globals.location = { href: `file://${coreDir}/` };

    try {
      const core = await factory({
        wasmBinary,
        // Swallow Emscripten's own stdout/stderr; everything we need arrives
        // through setLogger instead.
        print: () => {},
        printErr: () => {},
        locateFile: (path: string) => join(coreDir, path),
      });
      core.setTimeout(-1);
      return core;
    } finally {
      if (hadSelf) globals.self = prevSelf;
      else delete globals.self;
      if (hadLocation) globals.location = prevLocation;
      else delete globals.location;
    }
  })();

  return corePromise;
}

/** Loads the wasm core without running anything — used by `video_setup`. */
export async function warmUpFFmpeg(): Promise<void> {
  await getCore();
}

// ---------------------------------------------------------------------------
// Lazy host-file mount
// ---------------------------------------------------------------------------

const LAZY_MOUNT_DIR = "/media";

/**
 * Mounting is one-shot: this build of the core exports no `FS.unmount`, so the
 * mount is created once with a fixed set of filenames and each job re-points the
 * node it needs. Remounting per job would leak a mount entry every call.
 */
let lazyNodes: Map<string, EmscriptenNode> | null = null;
let lazyUnavailable = false;

function lazyDisabledByEnv(): boolean {
  const flag = process.env.CVV_DISABLE_LAZY_INPUT;
  return flag === "1" || flag === "true";
}

function ensureLazyMount(core: FFmpegCore): Map<string, EmscriptenNode> | null {
  if (lazyNodes) return lazyNodes;
  if (lazyUnavailable || lazyDisabledByEnv()) return null;

  try {
    const workerFs = core.FS.filesystems?.WORKERFS;
    if (!workerFs) throw new Error("WORKERFS is not present in this core build");

    installFileReaderSync();
    core.FS.mkdir(LAZY_MOUNT_DIR);
    core.FS.mount(
      workerFs,
      { blobs: LAZY_INPUT_NAMES.map((name) => ({ name, data: EMPTY_CHUNK })) },
      LAZY_MOUNT_DIR,
    );

    const nodes = new Map<string, EmscriptenNode>();
    for (const name of LAZY_INPUT_NAMES) {
      nodes.set(name, core.FS.lookupPath(`${LAZY_MOUNT_DIR}/${name}`).node);
    }

    lazyNodes = nodes;
    return lazyNodes;
  } catch (error) {
    // Any surprise here means the caller falls back to copying the file into
    // memory, which always works.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[cvv] Lazy file access unavailable (${detail}); falling back to in-memory input.`);
    lazyUnavailable = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

// One wasm instance means one MEMFS, one `ret` register and one logger. Every
// job therefore has to run to completion before the next one starts.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Job API
// ---------------------------------------------------------------------------

export interface FFmpegExecResult {
  /** ffmpeg exit code — 0 on success. */
  code: number;
  /** Everything the run wrote to stdout/stderr, newline-joined. */
  log: string;
}

/**
 * Only `exec` is exposed on purpose.
 *
 * The core also exports `ffprobe()`, but the two share one Emscripten instance
 * and calling `ffprobe()` leaves it in a state where every subsequent `exec()`
 * aborts immediately with an empty log. Since the plugin needs frames and
 * metadata from the same instance, metadata is parsed out of `ffmpeg -i`
 * instead (see `parseProbeLog`).
 */
export interface FFmpegJob {
  /** MEMFS scratch directory owned by this job. Removed when the job ends. */
  readonly dir: string;
  /**
   * Exposes a host file inside the wasm filesystem without copying it into
   * memory, and returns its path there. Returns `null` when lazy access is
   * unavailable — the caller must then fall back to `writeFile`.
   */
  mountHostFile(hostPath: string, extension: string): string | null;
  writeFile(name: string, data: Uint8Array): string;
  mkdir(name: string): string;
  exec(args: string[]): FFmpegExecResult;
  readFile(path: string): Uint8Array;
  readText(path: string): string;
  list(path: string): string[];
  exists(path: string): boolean;
}

function removeRecursive(fs: EmscriptenFS, path: string): void {
  let stat: EmscriptenStat;
  try {
    stat = fs.stat(path);
  } catch {
    return;
  }

  if (fs.isDir(stat.mode)) {
    for (const entry of fs.readdir(path)) {
      if (entry === "." || entry === "..") continue;
      removeRecursive(fs, `${path}/${entry}`);
    }
    try {
      fs.rmdir(path);
    } catch {
      /* best effort */
    }
    return;
  }

  try {
    fs.unlink(path);
  } catch {
    /* best effort */
  }
}

let jobCounter = 0;

/**
 * Runs `fn` against an exclusive ffmpeg job. Calls are serialised globally, and
 * the job's MEMFS directory is always removed afterwards — MEMFS is RAM, so
 * leaking it would leak memory for the lifetime of the server.
 */
export function withFFmpegJob<T>(fn: (job: FFmpegJob) => Promise<T> | T): Promise<T> {
  return enqueue(async () => {
    const core = await getCore();
    const dir = `/job${jobCounter++}`;
    core.FS.mkdir(dir);

    let logs: string[] = [];
    core.setLogger(({ message }) => {
      if (typeof message === "string") logs.push(message);
    });

    const run = (args: string[]): FFmpegExecResult => {
      logs = [];
      let code: number;
      try {
        core.exec(...args);
        code = core.ret;
      } catch (error) {
        // An Emscripten `abort()` surfaces as a thrown value. The log usually
        // explains why, so keep it and report a non-zero code.
        code = typeof core.ret === "number" && core.ret !== 0 ? core.ret : 1;
        logs.push(error instanceof Error ? error.message : String(error));
      } finally {
        // Clears the internal arg/return state so the next run starts clean
        // even when this one aborted.
        core.reset();
      }
      return { code, log: logs.join("\n") };
    };

    // File descriptors opened by mountHostFile, released when the job ends.
    const openFds: number[] = [];
    const claimedNodes: EmscriptenNode[] = [];

    const job: FFmpegJob = {
      dir,
      mountHostFile(hostPath, extension) {
        const nodes = ensureLazyMount(core);
        if (!nodes) return null;

        const name = lazyInputNameFor(extension);
        const node = nodes.get(name);
        if (!node) return null;

        let fd: number;
        try {
          fd = openSync(hostPath, "r");
        } catch {
          return null;
        }

        openFds.push(fd);
        claimedNodes.push(node);

        const size = fstatSync(fd).size;
        node.contents = createLazyChunk(fd, size);
        node.size = size;

        return `${LAZY_MOUNT_DIR}/${name}`;
      },
      writeFile(name, data) {
        const path = `${dir}/${name}`;
        core.FS.writeFile(path, data);
        return path;
      },
      mkdir(name) {
        const path = `${dir}/${name}`;
        core.FS.mkdir(path);
        return path;
      },
      exec: (args) => run(args),
      readFile: (path) => core.FS.readFile(path),
      readText: (path) => Buffer.from(core.FS.readFile(path)).toString("utf-8"),
      list: (path) => core.FS.readdir(path).filter((e) => e !== "." && e !== ".."),
      exists: (path) => core.FS.analyzePath(path).exists,
    };

    try {
      return await fn(job);
    } finally {
      core.setLogger(() => {});
      removeRecursive(core.FS, dir);

      // The mount itself is permanent, so detach the file from it and release
      // the descriptor — otherwise a long-lived server leaks one fd per call.
      for (const node of claimedNodes) {
        node.contents = EMPTY_CHUNK;
        node.size = 0;
      }
      for (const fd of openFds) {
        try {
          closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
  });
}
