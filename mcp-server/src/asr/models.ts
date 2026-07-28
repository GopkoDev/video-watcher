import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { totalmem } from "os";
import { MODELS_DIR } from "../config.js";
import type { WhisperModelName, WhisperModelSetting } from "../types.js";

export interface WhisperModelSpec {
  name: WhisperModelName;
  repo: string;
  /** Quantisation passed to transformers.js. */
  dtype: "q8";
  approx_download_mb: number;
  notes: string;
}

/**
 * Sizes are the quantised encoder + merged decoder as published, rounded.
 *
 * Model size is not limited by the WebAssembly ffmpeg build: transcription runs
 * on onnxruntime-node, which is native code. The only real costs of a bigger
 * model are download size, disk, and inference time.
 */
export const WHISPER_MODELS: Record<WhisperModelName, WhisperModelSpec> = {
  tiny: {
    name: "tiny",
    repo: "onnx-community/whisper-tiny",
    dtype: "q8",
    approx_download_mb: 39,
    notes: "fastest, roughest transcript",
  },
  base: {
    name: "base",
    repo: "onnx-community/whisper-base-ONNX",
    dtype: "q8",
    approx_download_mb: 174,
    notes: "small step up from tiny",
  },
  small: {
    name: "small",
    repo: "onnx-community/whisper-small",
    dtype: "q8",
    approx_download_mb: 238,
    notes: "solid for English, weaker on other languages",
  },
  medium: {
    name: "medium",
    repo: "onnx-community/whisper-medium-ONNX",
    dtype: "q8",
    approx_download_mb: 940,
    notes: "clearly better on non-English speech",
  },
  "large-v3-turbo": {
    name: "large-v3-turbo",
    repo: "onnx-community/whisper-large-v3-turbo",
    dtype: "q8",
    approx_download_mb: 1035,
    notes: "large-v3 accuracy with a 4-layer decoder — the best quality/speed trade",
  },
  "large-v3": {
    name: "large-v3",
    repo: "onnx-community/whisper-large-v3-ONNX",
    dtype: "q8",
    approx_download_mb: 1738,
    notes: "highest accuracy, slowest",
  },
};

export function totalRamGb(): number {
  return Math.round(totalmem() / 1024 ** 3);
}

/** Picks the largest model the machine can comfortably run. */
export function recommendWhisperModel(ramGb: number = totalRamGb()): WhisperModelName {
  if (ramGb < 8) return "tiny";
  if (ramGb < 16) return "small";
  return "large-v3-turbo";
}

export function resolveWhisperModel(
  setting: WhisperModelSetting,
  ramGb: number = totalRamGb(),
): WhisperModelSpec {
  const name = setting === "auto" ? recommendWhisperModel(ramGb) : setting;
  return WHISPER_MODELS[name] ?? WHISPER_MODELS[recommendWhisperModel(ramGb)];
}

export function getModelsDir(): string {
  if (!existsSync(MODELS_DIR)) {
    mkdirSync(MODELS_DIR, { recursive: true });
  }
  return MODELS_DIR;
}

/**
 * transformers.js caches a repo as `<cacheDir>/<org>/<name>/…`, with the ONNX
 * weights under `onnx/`. Both have to be present for an offline run to work.
 */
export function isModelCached(spec: WhisperModelSpec): boolean {
  const dir = join(MODELS_DIR, spec.repo);
  if (!existsSync(join(dir, "config.json"))) return false;

  const onnxDir = join(dir, "onnx");
  if (!existsSync(onnxDir)) return false;

  try {
    return readdirSync(onnxDir).some((file) => file.endsWith(".onnx"));
  } catch {
    return false;
  }
}
