<p align="center">
  <img src="./assets/hero.avif" alt="VideoWatcher" width="100%" />
</p>

# VideoWatcher

MCP plugin for Claude Code that lets Claude **watch local video files**: it extracts frames and transcribes audio entirely inside the Node process — no external system binary, and no network calls at runtime beyond a one-time whisper model download on first use.

## How it works

| Component | Implementation | Why |
|---|---|---|
| Frame extraction | `@ffmpeg/core` (ffmpeg.wasm) | One universal artifact that behaves identically on every platform. Native `ffmpeg` / `ffmpeg-static` would mean a system install or prebuilt binaries that macOS Gatekeeper quarantines — exactly the setup pain this avoids. |
| Audio → text | `@huggingface/transformers` (transformers.js) with whisper models from tiny to large-v3 | Fully local, no API keys. The model is downloaded once on first run and cached. |

Both arrive as regular npm dependencies, so a single `npm install` is the whole setup.

## Features

- **Multimodal perception** — Claude sees the actual frames and reads a timestamped transcript
- **Zero setup** — no ffmpeg, no whisper.cpp, no Python, no API keys
- **Offline after first run** — the only network call is the initial model download
- **Automatic model selection** — whisper size is picked from installed RAM
- **Automatic language detection** — the spoken language is detected from the audio itself
- **Structural analysis first** — scene changes, silence, motion and loudness let Claude decide where to look before spending tokens on frames

## Quick Start

Clone and build once:

```bash
git clone https://github.com/GopkoDev/video-watcher.git
cd video-watcher/mcp-server && npm install && npm run build
```

Then, inside Claude Code, run these **one at a time**:

```
/plugin marketplace add /path/to/video-watcher
```

```
/plugin install video-watcher@gopko-dev
```

That's it — there is nothing else to configure. The plugin runs straight from the checkout, so `npm run build` after a change is enough to pick it up.

Optionally warm everything up (loads ffmpeg and downloads the whisper model up front):

```
/setup-video-vision
```

Alternative: load it for one session only, without installing:

```bash
claude --plugin-dir /path/to/video-watcher
```

To install into a specific Claude Code profile, prefix the commands with its config directory:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin marketplace add /path/to/video-watcher
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin install video-watcher@gopko-dev
```

## Usage

### Slash command

```
/watch-video path/to/video.mp4
/watch-video tutorial.mp4 "what language is used in this tutorial?"
```

### Conversational

Just mention a video file — Claude will pick it up:

> "analyze this video for me: ~/Downloads/demo.mp4"
>
> "take a look at the first second of ~/videos/bug-report.mov"

Claude adapts the parameters to the question:
- "the first second" → high fps over a one-second range
- "summarize this 1h lecture" → low fps across the full duration
- "what text is on screen at 1:30?" → high resolution, narrow window

## MCP Tools

- `video_watch` — extract frames + transcribe audio (main tool)
- `video_analyze` — ffmpeg filter analysis (scenes, silence, motion, loudness…) before extraction
- `video_detail` — drill into specific moments; extract many frames, view few
- `video_info` — metadata only
- `video_configure` — change settings
- `video_setup` — report what will be used, and optionally prefetch the model

## Slash Commands

- `/watch-video <path> [question]` — analyze a video
- `/setup-video-vision` — check status and preferences

## Whisper models

Transcription runs on `onnxruntime-node`, which is native code — the WebAssembly ffmpeg build
does not constrain model size. The only costs of a bigger model are download, disk and time.

| Model | Download | Speed | 1h of video | Good for |
|---|---|---|---|---|
| `tiny` | 39 MB | ~15× realtime | ~4 min | rough English notes |
| `base` | 174 MB | ~8.7× realtime | ~7 min | quick passes |
| `small` | 238 MB | ~4.2× realtime | ~14 min | solid English |
| `medium` | 940 MB | ~2.5× realtime | ~24 min | non-English speech |
| `large-v3-turbo` | 1.0 GB | ~1.6× realtime | ~36 min | best quality/speed trade |
| `large-v3` | 1.7 GB | ~0.6× realtime | ~100 min | maximum accuracy |

Measured on Apple Silicon with the q8 weights; your numbers will differ, but the ratios hold.

`whisper_model: "auto"` (the default) picks from installed RAM: `tiny` below 8 GB, `small` below
16 GB, `large-v3-turbo` at 16 GB and above. Override at any time:

```
video_configure({ whisper_model: "small" })   # or tiny / base / medium / large-v3-turbo / large-v3
```

Models are cached in `~/.claude-video-vision/models/`. After the first download everything runs
offline. To reclaim space, delete a model's directory — it is re-fetched only if you select it again.

## Configuration

Settings live in `~/.claude-video-vision/config.json`:

```json
{
  "whisper_model": "auto",
  "whisper_language": "auto",
  "frame_format": "jpeg",
  "frame_resolution": 512,
  "default_fps": "auto",
  "max_frames": 100,
  "max_input_mb": 1024,
  "enable_index": false,
  "session_max_age_days": 7
}
```

- `whisper_model` — `auto`, `tiny`, `base`, `small`, `medium`, `large-v3-turbo` or `large-v3`
- `whisper_language` — `auto` to detect per video, or an ISO-639-1 code such as `en`, `uk`, `de`
- `frame_format` — `jpeg` (default), `png` (lossless, good for screen recordings), or `webp`
- `max_input_mb` — safety net for the rare setup where ffmpeg cannot read the file lazily and has to load it into memory instead. It does not apply on the normal path.

## Requirements

- **Node.js 20+**

Nothing else.

## Limits worth knowing

- **wasm ffmpeg is single-threaded** and slower than a native build. Analysis and frame extraction on short clips are near-instant; a feature-length film is not the target.
- **Video size is not a limit.** ffmpeg reads the file lazily off disk, so memory does not scale with it — a 568 MB / 69-minute 1080p file costs ~180 MB of RAM and returns frames from minute 10 in about a second. If lazy access ever turns out to be unavailable, the plugin copies the file into memory instead and `max_input_mb` (1 GB by default) applies.
- **`@ffmpeg/core` is GPL-2.0-or-later.** The plugin itself is MIT, and the GPL core is a separate, dynamically loaded npm package — but bear it in mind when redistributing.

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Maintained by **Dmytro Hopko** ([@GopkoDev](https://github.com/GopkoDev)).

Forked from [claude-video-vision](https://github.com/jordanrendric/claude-video-vision) by
**Jordan Vasconcelos** ([@jordanrendric](https://github.com/jordanrendric)), and rewritten in
2.0 around a single dependency-free local backend.
