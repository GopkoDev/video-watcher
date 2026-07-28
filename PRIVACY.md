# Privacy Policy

**Last updated:** 2026-07-28

This document describes how `video-watcher` handles your data.

## Summary

- **No telemetry**, no analytics, no account, no API key.
- **No data is collected** by the maintainer of this plugin.
- **Your video never leaves your machine.** Frames and audio are processed inside the
  plugin's own Node process.

## Data the plugin processes

When you ask Claude to analyze a video:

1. **The video file you provide** is read from your local filesystem into memory.
2. **Frames are extracted** by ffmpeg compiled to WebAssembly, running in-process. They
   live in an in-memory filesystem that is discarded when the call ends.
3. **Audio is decoded** to raw samples in memory and transcribed locally by a whisper model
   through transformers.js.
4. **Frames and transcript are returned to Claude Code**, which is what lets Claude answer
   your question.

No part of the video, audio or transcript is uploaded anywhere by this plugin.

## Network activity

The plugin makes exactly two kinds of network request, both outside normal operation:

- **npm registry** — when `npx` fetches the MCP server and its dependencies at install time.
- **HuggingFace** — a one-time download of public whisper model weights
  (`huggingface.co/onnx-community/whisper-{tiny,base,small}`) the first time you transcribe
  anything. The request contains no video data. After it completes, transcription works
  offline.

You can perform that download up front with `/setup-video-vision`. There is no other
outbound traffic — no telemetry endpoint, no analytics, no crash reporting.

## Local files

The plugin writes and reads these locations:

- `~/.claude-video-vision/config.json` — your extraction preferences
- `~/.claude-video-vision/models/` — cached whisper model weights
- `~/.claude-video-vision/sessions/` — cached frames, **only when `enable_index` is enabled**;
  entries expire after `session_max_age_days` (7 by default) and can be wiped at any time
  with `video_configure({ clear_sessions: true })`

Nothing else is written to disk: frames and audio for a single call exist only in memory.
None of these files leave your machine.

## What the maintainer can see

**Nothing.** The plugin does not phone home.

## Your responsibilities

- Frames of your video are sent to Claude as images, and the transcript as text, because
  that is what "watching a video" means here. They are therefore subject to your Claude
  Code / Anthropic API data handling settings. Treat a video you analyze the same way you
  would treat a file you paste into a conversation.
- Cached session frames (`enable_index`) persist on disk until they expire. Turn the cache
  off or clear it when working with sensitive footage.

## Changes to this policy

Changes are committed to this file in the public GitHub repository. The git history is the
audit trail.

## Contact

Open an issue at https://github.com/GopkoDev/video-watcher/issues or reach out to
[@GopkoDev](https://github.com/GopkoDev).
