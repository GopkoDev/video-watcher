export type WhisperModelName =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large-v3-turbo"
  | "large-v3";
export type WhisperModelSetting = WhisperModelName | "auto";
export type FrameFormat = "jpeg" | "png" | "webp";

export interface Config {
  /** Whisper size; "auto" picks one from installed RAM. */
  whisper_model: WhisperModelSetting;
  /** ISO-639-1 code, or "auto" to detect it from the first 30s of audio. */
  whisper_language: string;
  frame_format: FrameFormat;
  frame_resolution: number;
  default_fps: number | "auto";
  max_frames: number;
  /** Upper bound on the video size that may be loaded into wasm memory. */
  max_input_mb: number;
  enable_index: boolean;
  session_max_age_days: number;
}

export interface VideoMetadata {
  duration: string;
  duration_seconds: number;
  resolution: string;
  width: number;
  height: number;
  codec: string;
  original_fps: number;
  file_size: string;
  has_audio: boolean;
}

export interface Frame {
  timestamp: string;
  image?: string;
  format?: FrameFormat;
  /** Absolute host path — only set when the frame was cached in a session. */
  sourcePath?: string;
}

export interface TranscriptionSegment {
  start: string;
  end: string;
  text: string;
}

export interface AudioResult {
  engine: "whisper" | "none";
  /** HuggingFace repo of the model that produced the transcript. */
  model: string | null;
  /** Language used for decoding. */
  language: string | null;
  /** True when the language was detected rather than configured. */
  language_detected: boolean;
  transcription: TranscriptionSegment[];
  full_text: string;
  /** Set when audio was skipped — explains why the transcript is empty. */
  skipped_reason?: string;
}

export interface VideoWatchResult {
  metadata: VideoMetadata;
  frames: Frame[];
  audio: AudioResult;
}

export interface AnalysisFilters {
  scene_changes: boolean;
  black_intervals: boolean;
  silence: boolean;
  freeze: boolean;
  motion: boolean;
  blur: boolean;
  exposure: boolean;
  loudness: boolean;
  transcription: boolean;
}

export interface SceneChange {
  time: string;
  score: number;
}

export interface Interval {
  start: string;
  end: string;
  duration: number;
}

export interface FrameStats {
  timestamp: string;
  blur?: number;
  brightness?: number;
  saturation?: number;
}

export interface VideoAnalysis {
  scenes: SceneChange[];
  black_intervals: Interval[];
  silence_intervals: Interval[];
  freeze_intervals: Interval[];
  frame_stats: FrameStats[];
  loudness_summary?: { mean_lufs: number; range_lu: number };
  transcription?: TranscriptionSegment[];
  content_profile: string;
}

export interface SessionManifest {
  video_hash: string;
  video_path: string;
  created_at: string;
  resolutions: Record<string, {
    frames: Array<{ timestamp: string; file: string }>;
  }>;
  analysis?: VideoAnalysis;
}

export interface Segment {
  start: string;
  end: string;
  fps: number;
  resolution?: number;
}
