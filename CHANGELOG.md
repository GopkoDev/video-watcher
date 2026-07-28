# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-07-28

### Added

- **Lazy file access** — ffmpeg now reads the source video off disk in chunks instead of receiving a full copy in wasm memory. Emscripten's WORKERFS supports this but expects the browser-only `FileReaderSync`; the plugin supplies a Node implementation backed by `fs.readSync`.

  Measured on a 568 MB / 69-minute 1080p file (5 frames from minute 10 plus 10s of audio): peak RSS **+183 MB instead of +1344 MB**, and 1087 ms instead of 1509 ms, with byte-identical output.

  Consequences: video size is no longer a practical limit, and memory no longer scales with it. `max_input_mb` still exists but now only guards the fallback path.

- **`CVV_DISABLE_LAZY_INPUT=1`** forces the previous in-memory behaviour, for the case where a future `@ffmpeg/core` release changes the internals this relies on. The plugin also falls back on its own, with a note on stderr, if the mount cannot be established.

- **`medium`, `large-v3-turbo` and `large-v3` whisper models.** The registry was capped at `small` on the reasoning that wasm cannot run anything bigger — but only ffmpeg is WebAssembly, while transcription runs on `onnxruntime-node`, which is native. Model size is therefore unconstrained; the only costs are download, disk and time.

### Changed

- **`whisper_model: "auto"` now picks `large-v3-turbo` at 16GB of RAM and above** (`tiny` below 8GB, `small` below 16GB) — the accuracy tier the 1.x plugin used, at a fraction of its cost. This supersedes the `tiny` / `base` / `small` split introduced in 2.0.0.
- **Renamed to VideoWatcher.** The plugin is `video-watcher`, the npm package is `@gopkodev/video-watcher`, and the repository moved to [GopkoDev/video-watcher](https://github.com/GopkoDev/video-watcher). Reinstall with `/plugin install video-watcher@gopko-dev` — the old plugin name will not resolve.
- **Approximate download sizes corrected** in `video_setup` and the docs: `tiny` 39MB, `base` 174MB, `small` 238MB. The previous numbers (45 / 85 / 260) were wrong for the published q8 weights.

### Fixed

- **`base` no longer fails on first use.** The registry pointed at `onnx-community/whisper-base`, which does not exist, so every 8–16GB machine — where `auto` selected `base` in 2.0.0 — would have failed on its first transcription. The published repository is `onnx-community/whisper-base-ONNX`.
- **The npm package now ships a README and a LICENSE.** `files` listed both, but they live in the repository root rather than in `mcp-server/`, so the published tarball would have contained neither; `prepack` copies them in and `postpack` removes them again. A scoped package also defaults to restricted access, which would have failed the first publish — `publishConfig.access` is now `public`.

## [2.0.0] - 2026-07-28

Rewrite around a single, dependency-free local backend. The plugin now runs entirely inside the Node process: no system binary has to be installed, and the only network call is a one-time whisper model download.

### Added

- **ffmpeg as WebAssembly** — frame extraction, audio decoding and all analysis filters now run through `@ffmpeg/core` in-process. Nothing to install, identical behaviour on every platform.
- **Local whisper via transformers.js** — `@huggingface/transformers` replaces whisper.cpp and the Python CLI. Models are cached in `~/.claude-video-vision/models/` and reused offline.
- **Automatic model selection** — whisper size is derived from installed RAM (`tiny` < 8GB, `base` < 16GB, `small` otherwise) and can still be pinned with `video_configure`.
- **Automatic language detection** — the spoken language is read from whisper's own first decoder step instead of silently defaulting to English. Reported as `language` / `language_detected` in the result.
- **`max_input_mb` guard** — videos too large for wasm memory are refused with an actionable message instead of crashing the server.
- **`max_frames` truncation warning** — `video_watch` now says so when the frame cap cut the requested range short, rather than silently returning partial coverage.
- **`~` expansion** in every `path` parameter.
- **`video_setup` prefetch** — loads ffmpeg and downloads the model up front.

### Removed

- **Gemini API and OpenAI backends**, along with `GEMINI_API_KEY` / `OPENAI_API_KEY` handling and the `backend` setting. There is one backend now, and it is local.
- **YouTube URL support** (`yt-dlp` download, subtitle/auto-caption extraction, the downloads cache). Only local files are accepted.
- **Audio chunking** (`audio_chunk_*` settings) — it only ever applied to the Gemini backend.
- **`frame_mode: "descriptions"` and the `frame-describer` agent** — the agent was never registered by the plugin manifest, and the mode returned every image anyway, so it saved nothing.
- **`whisper_engine`, `whisper_at`, `audio_tags`** — the Python engine parsed the wrong stream and produced a single unusable segment; audio tagging never worked as a result.
- **`ffprobe`** — the shared wasm instance permanently breaks `exec()` once `ffprobe()` has run on it, so metadata is parsed from `ffmpeg -i` output instead.

### Fixed

- **`end_time` is now absolute for frames.** With `-ss` before `-i`, ffmpeg measured `-to` from the seek point, so `start_time: 00:00:05, end_time: 00:00:10` extracted ten seconds of frames while the audio covered five. Both paths now emit an explicit `-t (end − start)`.
- **Session frames no longer overwrite each other.** `video_watch` wrote ffmpeg's sequential `frame_0001…` names straight into the session cache, so a later call with a different range silently replaced cached frames the manifest still pointed at. Frames are now always stored under timestamp-derived names.
- **Temporary files no longer leak** when `enable_index` is on — there are no scratch files on disk at all now.
- **A corrupt `config.json` no longer breaks every tool** — it falls back to defaults and reports the problem on stderr.
- **`default_fps` is honoured.** It was declared, documented and never read.
- **`metadata.duration` includes hours** — it previously rendered 1h15m as `75:30`.

## [1.2.1] - 2026-04-26

### Fixed

- **openai-whisper Python backend:** `video_watch` no longer crashes with `argument --language: invalid choice: 'auto'` on every call. The openai-whisper CLI accepts only explicit ISO codes for `--language` (or omission for the built-in 30-second auto-detection). The `--language auto` argument has been removed from the Python branch; the `whisper.cpp` branch is unchanged because cpp does accept `auto`.
- **Stray `audio.json` in user CWD:** the openai-whisper CLI writes its JSON output to the working directory by default. The Python backend now passes `--output_dir` pointing at the same scratch directory as the input wav, and best-effort removes the file after parsing stdout, so users no longer find an orphan `audio.json` next to their project files after every `video_watch` call.

## [1.2.0] - 2026-04-25

### Added

- **New tool: `video_analyze`** — Runs ffmpeg analytical filters (scdet, blackdetect, silencedetect, freezedetect, siti, blurdetect, signalstats, ebur128) in a single pass. Claude selects which filters to use based on the user's question. Optional audio transcription via configured backend. Returns structured JSON with scene changes, silence intervals, motion profile, and content classification.
- **New tool: `video_detail`** — Drill-down into specific video segments with variable FPS/resolution. Separates extraction from viewing: extract many frames to disk, view only a subset. Supports `view_sample` for evenly spaced frames and `view` for specific timestamps.
- **Session system** (`enable_index` config) — Persistent sessions at `~/.claude-video-vision/sessions/{video-hash}/`. Manifest tracks frames by resolution, deduplicates across calls. Auto-cleanup of expired sessions on server startup via `session_max_age_days`.
- **Segment-based extraction** — `video_watch` and `video_detail` now accept a `segments` param for variable FPS/resolution per time range, enabling smart extraction driven by analysis data.
- **`view_sample` param** on `video_watch` — Returns N evenly spaced frames instead of all, reducing context usage.
- **`clear_sessions` action** on `video_configure` — Deletes all cached sessions.

### Changed

- **Skill rewrite (video-perception + watch-video):** New analyze-first workflow. For videos > 30s, Claude calls `video_analyze` to get structural data + transcription before extracting frames. Short videos (< 2min) use full auto FPS for complete coverage.
- **`video_configure`** now accepts `enable_index` and `session_max_age_days` params.

### Fixed

- **Command injection in whisper model download:** Replaced shell-interpolated curl invocation with `execFile` array arguments, preventing injection via crafted model paths.
- **Model integrity verification:** Added streaming SHA-256 checksum verification for all 12 whisper model downloads (verified against HuggingFace Git LFS pointers, including `large-v3-turbo`). Uses `createReadStream` + `pipeline` to avoid OOM on large models.
- **Input validation:** Added `validateVideoPath()` (shared module) for path resolution and file type checks. Added `HMS_REGEX` validation on `start_time`/`end_time` params to prevent ffmpeg argument injection.
- **`skip_audio` flag and `has_audio` detection:** `video_watch` now gracefully skips audio extraction when the video has no audio stream or `skip_audio: true`.
- **ffmpeg filter output parsing:** Fixed `ametadata` vs `metadata` filter mismatch in audio chain. Fixed `parseSitiOutput` regex to match actual ffmpeg SITI Summary format. Always appends metadata sink to video filter chain for scdet capture.

### Security

- Inspired by [@urielka](https://github.com/urielka)'s [fork](https://github.com/urielka/claude-video-vision), which identified the shell injection fix and proposed model checksum verification. Our implementation corrects the checksum values for `base.en` and `large-v3`, uses streaming hashing to avoid OOM, and adds `large-v3-turbo` coverage. Thanks for the contribution!

### Tests

- 50 new unit tests (types, config, session manager, session manifest, analyzers, segment extraction). Total suite: 91/91 passing.

## [1.1.0] - 2026-04-23

### Fixed

- **Gemini API backend:** `video_watch` no longer fails with `FAILED_PRECONDITION` on every call. The backend now polls the uploaded file's state via `ai.files.get()` until it reaches `ACTIVE` before calling `generateContent`. Thanks to [@JaredTheHammer](https://github.com/JaredTheHammer) for the precise diagnosis ([#19](https://github.com/jordanrendric/claude-video-vision/issues/19)).
- **Timestamp alignment across cropped windows:** when `video_watch` is called with `start_time`, audio backends previously returned timestamps relative to the cropped audio (starting at `00:00:00`), misaligning with the frame timestamps. All three backends and the frame extractor now emit timestamps relative to the original video timeline.

### Changed

- **Gemini backend now audio-only.** `analyzeWithGeminiApi()` accepts an audio path instead of a video path. `video_watch` extracts audio via ffmpeg (16kHz mono wav) before calling the backend, matching the pattern already used by `local` and `openai`. Cuts upload size and token cost dramatically.
- **Gemini backend returns structured JSON.** Uses `responseMimeType: "application/json"` with a `responseJsonSchema` defining `transcription` and `audio_tags` arrays with `HH:MM:SS` timestamps. `AudioResult.transcription` and `AudioResult.audio_tags` are now populated directly; `full_analysis` is `null`, matching the other backends.

### Added

- Shared `src/utils/timestamps.ts` helper with `parseHMS`, `formatHMS`, and `shiftAudioResult`. Removes duplicated `formatTime` functions from `local.ts`, `openai.ts`, and `frames.ts`.
- Integration test script `scripts/test-gemini-api.ts` for validating the Gemini backend against a real API key end-to-end. Run via `npm run test:gemini -- <video-path>`.
- Offline token measurement script `scripts/measure-tokens.ts` (standalone, no API key required). Uses `js-tiktoken` and Anthropic's `(w*h)/750` image-token formula to estimate `video_watch` token cost. Run via `npm run measure -- <video-path>` or `--matrix`.

### Tests

- 26 new unit tests (8 for Gemini file-state polling, 18 for timestamp helpers). Total suite: 41/41 passing on Ubuntu and macOS, Node 20 and 22.

## [1.0.2] - 2026-04-22

### Changed

- Switched release workflow to npm Trusted Publisher (OIDC). No long-lived `NPM_TOKEN` required.

## [1.0.1] - 2026-04-22

### Changed

- MCP server published to npm as [`claude-video-vision`](https://www.npmjs.com/package/claude-video-vision)
- Plugin `.mcp.json` now invokes the server via `npx -y claude-video-vision@latest` — no local `npm install` or `npm run build` required
- Added `Release` GitHub workflow: tagging `v*` publishes to npm automatically (with provenance)

## [1.0.0] - 2026-04-22

### Added

- MCP server with 4 tools: `video_watch`, `video_info`, `video_setup`, `video_configure`
- Frame extraction via ffmpeg with configurable fps and resolution
- Audio extraction and transcription via multiple backends:
  - Gemini API (native audio understanding)
  - Local Whisper (`whisper.cpp` + Python `openai-whisper`)
  - OpenAI Whisper API
- Interactive setup wizard: `/setup-video-vision`
- Slash command: `/watch-video`
- Skill `video-perception` that teaches Claude to detect video references automatically
- Sub-agent `frame-describer` for text-based frame descriptions
- Auto-download of Whisper models from HuggingFace on first use
- Adaptive parameter selection: fps, resolution, and time ranges adapt to the user's question
- Parallel processing of frames and audio
- Platform detection (macOS/Linux/Windows, Apple Silicon/x64/NVIDIA)
- Persistent configuration at `~/.claude-video-vision/config.json`

### Notes

- Gemini CLI was considered but not included — its Cloud Code API does not support audio/video via function calling.
