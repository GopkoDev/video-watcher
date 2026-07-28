---
description: "Watch and analyze a local video file — extracts frames and transcribes audio"
argument-hint: "path/to/video.mp4 [optional prompt or question about the video]"
---

# Watch Video

Parse the user's input to extract:
1. **Video path** — a local file path (required; `~` is fine)
2. **Prompt** — any question or instruction about the video (optional)
3. **Flags** — `--fps <number>`, `--resolution <number>` (optional)

Then follow this workflow **in order — do NOT skip step 2**:

1. Call `video_info` on the path to confirm it is a readable video and get its duration.

2. **REQUIRED for videos > 30s:** call `video_analyze` BEFORE `video_watch`. This is not optional.
   Use at least `scene_changes: true, silence: true, transcription: true`, plus whatever else the
   question calls for (motion, blur, exposure, loudness). The analysis tells you WHERE to look, so
   you can extract a handful of useful frames instead of hundreds of redundant ones.

3. Call `video_watch`:
   - **Short videos (< 2 min):** `fps: "auto"` with no `view_sample` — full coverage.
   - **Long videos (> 2 min):** `segments` with variable FPS derived from the analysis, plus
     `view_sample` to cap the initial frame count.

4. If the user wants more detail on a moment, use `video_detail` on a 3–5 second window at higher
   fps/resolution. Preview with `view_sample: 3`, then request exact timestamps.

5. Answer the user's question from what you saw and heard. With no question, give a comprehensive
   summary of what happens in the video.

Notes:
- Everything runs locally; there is nothing to install and no API key.
- The very first transcription downloads the whisper model (tens to hundreds of MB). If that is
  happening, say so rather than letting the wait look like a hang.
- Video size is not a limit: ffmpeg reads the source lazily off disk. If a call still fails on the
  in-memory fallback path, report the limit and offer to raise `max_input_mb` via `video_configure`
  or to work on a trimmed clip.
