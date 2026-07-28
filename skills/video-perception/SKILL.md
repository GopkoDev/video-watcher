---
name: video-perception
description: Use when the user mentions a video file (.mp4, .mov, .avi, .mkv, .webm), asks to watch/analyze/review a video, or references video content in conversation
---

# Video Perception

You can watch local video files through the VideoWatcher MCP server. It runs
entirely on the user's machine — ffmpeg as WebAssembly, whisper through
transformers.js — so there is nothing to install and nothing is sent anywhere.

## Available Tools

- `video_analyze` — analyze structure with ffmpeg filters (scene changes, silence, motion…). Use this BEFORE extracting frames to plan your strategy.
- `video_watch` — extract frames + transcribe audio. Supports variable FPS/resolution per segment.
- `video_detail` — drill into specific moments. Extraction is separate from viewing: extract many frames, view few at a time.
- `video_info` — metadata only.
- `video_configure` — change settings (whisper model, language, resolution, enable_index…).
- `video_setup` — report what will be used and optionally prefetch the whisper model.

## Workflow

**IMPORTANT: follow these steps in order. Do NOT skip step 2.**

1. Start with `video_info` to get duration, resolution and whether the file has audio.

2. **REQUIRED for videos > 30s:** call `video_analyze` BEFORE extracting any frames.
   This is not optional — it is what lets you avoid extracting hundreds of useless frames.
   Pick filters that match the question:

   | User intent | Filters |
   |---|---|
   | "What happens in this video?" | scene_changes, silence, transcription |
   | "Find the scene transitions" | scene_changes, black_intervals |
   | "Are there frozen/stuck parts?" | freeze, blur |
   | "Is this a talking head or action?" | motion |
   | "When does the music start?" | silence, loudness |
   | "Analyze the lighting" | exposure |
   | "Summarize this lecture" | transcription, scene_changes, silence |
   | General / unclear intent | scene_changes, silence, transcription |

   Include `transcription: true` whenever the video has audio — the transcript tells
   you WHERE to look visually.

3. Use the analysis to plan extraction:
   - Low FPS (0.1–0.5) for static or predictable stretches
   - Higher FPS (1–3) only around scene changes, motion peaks, or moments the speech
     points at ("look at this", "as you can see", "let me show you")
   - Never exceed the minimum FPS the task needs — you can always drill deeper

4. Call `video_watch`:
   - **Short videos (< 2 min):** `fps: "auto"` with no `view_sample` — short videos need
     full coverage so brief moments are not missed.
   - **Long videos (> 2 min):** `segments` based on the analysis, with `view_sample` to
     cap the initial frame count.

5. Use `video_detail` to drill in:
   - Start with 3–5 second windows around points of interest
   - `view_sample: 3` to preview (first, middle, last), then request exact timestamps with `view`
   - Treat frame viewing like a binary search — never view every extracted frame at once

6. For follow-up questions about the same video, reuse the manifest already in your
   context. Do not re-extract frames you already have at the same resolution, and do not
   re-request frames already in context.

## Parameter Guide

**fps:** `"auto"` for a general overview. Use the video's original fps for frame-by-frame
detail, 5–10 for short critical moments, 0.1–0.5 for long videos.

**resolution:** 256–512 for quick scans, 512–768 for normal analysis, 1024+ when reading
on-screen text.

**start_time / end_time:** both absolute positions in the video, in `HH:MM:SS`.

**segments:** use when you have analysis data. Each segment carries its own fps and
resolution and overrides the global fps/start_time/end_time for frames.

**view_sample:** returns N evenly spaced frames — the main defence against flooding your
context with images.

**skip_audio:** set when you only need the visuals.

**language:** transcription auto-detects the spoken language. Pass an ISO-639-1 code only
when the user names the language or detection clearly got it wrong.

## Working with Results

You receive:
- **Metadata** — duration, resolution, codec, audio presence
- **Frames** as images — look at them
- **Transcript** with timestamps, plus `language` and whether it was detected
- **Analysis data** — scene changes, silence, motion, loudness
- **Manifest** (when `enable_index` is on) — index of cached frames by resolution and timestamp

The analysis tells you WHEN things happen; the frames tell you WHAT happens. Combine them.

## Failure modes to expect

- **"Video is …MB, which exceeds the … limit"** — rare. ffmpeg normally reads the file lazily
  off disk, so size is not a limit; this only appears when the lazy mount is unavailable and the
  file has to be copied into wasm memory instead. Suggest raising `max_input_mb` via
  `video_configure`, or trimming the file.
- **A "Warning" block about `max_frames`** — the range was cut short. Lower the fps or narrow
  the range rather than silently reporting on partial coverage.
- **First transcription is slow** — the whisper model is downloading. It happens once.
