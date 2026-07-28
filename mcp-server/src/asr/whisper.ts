import { env, pipeline, Tensor } from "@huggingface/transformers";
import { formatHMS } from "../utils/timestamps.js";
import { getModelsDir, isModelCached, type WhisperModelSpec } from "./models.js";
import type { AudioResult, TranscriptionSegment } from "../types.js";

export const SAMPLE_RATE = 16000;

// Models live under ~/.claude-video-vision/models and are fetched from the
// HuggingFace hub exactly once. `allowLocalModels` refers to a *bundled*
// ./models folder, which we do not ship — the on-disk cache below is what makes
// subsequent runs offline.
env.cacheDir = getModelsDir();
env.allowLocalModels = false;

type AsrPipeline = Awaited<ReturnType<typeof pipeline<"automatic-speech-recognition">>>;

let loaded: { repo: string; pipe: AsrPipeline } | null = null;

/**
 * transformers.js reports `status: "download"` for cache hits too, so progress
 * is only narrated when the model genuinely is not on disk yet.
 */
function reportProgress(spec: WhisperModelSpec): (progress: unknown) => void {
  const announced = new Set<string>();
  return (progress: unknown) => {
    const p = progress as { status?: string; file?: string };
    if (p?.status !== "download" || !p.file || announced.has(p.file)) return;
    announced.add(p.file);
    console.error(`[cvv] Downloading ${spec.repo}/${p.file}`);
  };
}

export async function loadWhisper(spec: WhisperModelSpec): Promise<AsrPipeline> {
  if (loaded?.repo === spec.repo) return loaded.pipe;

  const cached = isModelCached(spec);
  if (!cached) {
    console.error(
      `[cvv] Fetching whisper-${spec.name} (~${spec.approx_download_mb}MB) — first run only, then it works offline.`,
    );
  }

  const pipe = await pipeline("automatic-speech-recognition", spec.repo, {
    dtype: spec.dtype,
    ...(cached ? {} : { progress_callback: reportProgress(spec) }),
  });

  loaded = { repo: spec.repo, pipe };
  return pipe;
}

/**
 * transformers.js has no language auto-detection: omitting `language` makes it
 * warn and force English. Whisper itself does know, though — the first decoder
 * step after the start token predicts a language token. Running that single
 * step (~150ms) and taking the arg-max over the language vocabulary gives us
 * the same answer the reference implementation reports.
 */
export async function detectLanguage(pipe: AsrPipeline, audio: Float32Array): Promise<string | null> {
  const model = pipe.model as any;
  const processor = pipe.processor as any;
  const generationConfig = model?.generation_config;
  const langToId: Record<string, number> | undefined = generationConfig?.lang_to_id;

  if (!generationConfig?.is_multilingual) return "en";
  if (!langToId || Object.keys(langToId).length === 0) return null;

  try {
    // Whisper's encoder always consumes a 30s window.
    const window = audio.subarray(0, SAMPLE_RATE * 30);
    const inputs = await processor(window);
    const output = await model.forward({
      input_features: inputs.input_features,
      decoder_input_ids: new Tensor("int64", [BigInt(generationConfig.decoder_start_token_id)], [1, 1]),
    });

    const logits = output.logits;
    const data = logits.data as Float32Array;
    const vocab = logits.dims[logits.dims.length - 1];
    const offset = data.length - vocab;

    let bestToken: string | null = null;
    let bestScore = -Infinity;
    for (const [token, id] of Object.entries(langToId)) {
      const score = data[offset + id];
      if (score > bestScore) {
        bestScore = score;
        bestToken = token;
      }
    }

    // Tokens look like "<|uk|>".
    return bestToken ? bestToken.replace(/[<>|]/g, "") : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[cvv] Language detection failed (${detail}); falling back to English.`);
    return null;
  }
}

export interface TranscribeOptions {
  spec: WhisperModelSpec;
  /** ISO code, or "auto" to detect. */
  language: string;
}

export async function transcribe(
  audio: Float32Array,
  options: TranscribeOptions,
): Promise<AudioResult> {
  const { spec, language } = options;

  if (audio.length === 0) {
    return emptyAudioResult("audio track is empty");
  }

  const pipe = await loadWhisper(spec);

  const wantsDetection = language === "auto" || language === "";
  const detected = wantsDetection ? await detectLanguage(pipe, audio) : null;
  const resolvedLanguage = wantsDetection ? detected ?? "en" : language;

  const output = (await pipe(audio, {
    language: resolvedLanguage,
    task: "transcribe",
    return_timestamps: true,
    // Whisper only sees 30s at a time; the stride gives neighbouring chunks
    // shared context so words on a boundary are not cut in half.
    chunk_length_s: 30,
    stride_length_s: 5,
  } as any)) as { text?: string; chunks?: Array<{ timestamp: [number, number | null]; text: string }> };

  const durationSeconds = audio.length / SAMPLE_RATE;
  const transcription: TranscriptionSegment[] = [];

  for (const chunk of output.chunks ?? []) {
    const text = (chunk.text ?? "").trim();
    if (!text) continue;

    const [start, end] = chunk.timestamp;
    transcription.push({
      start: formatHMS(start ?? 0),
      // The final chunk often comes back open-ended.
      end: formatHMS(end ?? durationSeconds),
      text,
    });
  }

  const fullText = (output.text ?? "").trim();

  // `return_timestamps` can still yield no chunks on very short clips.
  if (transcription.length === 0 && fullText) {
    transcription.push({ start: formatHMS(0), end: formatHMS(durationSeconds), text: fullText });
  }

  return {
    engine: "whisper",
    model: spec.repo,
    language: resolvedLanguage,
    language_detected: wantsDetection && detected !== null,
    transcription,
    full_text: fullText,
  };
}

export function emptyAudioResult(reason: string): AudioResult {
  return {
    engine: "none",
    model: null,
    language: null,
    language_detected: false,
    transcription: [],
    full_text: "",
    skipped_reason: reason,
  };
}
