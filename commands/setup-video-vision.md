---
description: "Check VideoWatcher status, prefetch the whisper model, and adjust preferences"
---

# Setup Video Vision

There is nothing to install — ffmpeg ships as WebAssembly and whisper runs through
transformers.js. This command is about showing the user what will be used and letting them
adjust it.

## Step 1: Show the current state

Call `video_setup` with `prefetch: false` and show the report: platform, RAM, which whisper
model was selected, and whether it has been downloaded yet.

## Step 2: Offer to prefetch

If the model is not downloaded yet, ask:

> The whisper model (~<size from the report>) downloads on first use. Want me to fetch it
> now so your first video is not slowed down by it?
>
> **a) Yes** — download now
>
> **b) No** — download it later, on the first video

On "yes", call `video_setup` with `prefetch: true` and report the result.

## Step 3: Offer preferences

Ask only what is worth asking, one question at a time. If the user says "defaults are fine",
skip the rest.

### Whisper model
> Whisper model size? Your machine has **<RAM from the report>**, so `auto` picks
> **<selected model>**. Bigger models only cost download, disk and time — transcription
> runs on native `onnxruntime-node`, so the WebAssembly ffmpeg build does not limit them.
>
> **a) auto** (recommended) — from available RAM: `tiny` below 8GB, `small` below 16GB,
> `large-v3-turbo` at 16GB and above
>
> **b) tiny** (~39MB) — fastest, roughest transcript
>
> **c) base** (~174MB) — a small step up from tiny
>
> **d) small** (~238MB) — solid for English, weaker on other languages
>
> **e) medium** (~940MB) — clearly better on non-English speech
>
> **f) large-v3-turbo** (~1.0GB) — best quality/speed trade
>
> **g) large-v3** (~1.7GB) — highest accuracy, slowest

Call `video_configure` with `whisper_model`.

### Language
> Transcription language?
>
> **a) auto** (recommended) — detected from the audio of each video
>
> **b) A fixed language** — ask for the ISO-639-1 code, e.g. `en`, `uk`, `de`

Call `video_configure` with `whisper_language`.

### Frame resolution
> Frame width in pixels (height scales automatically)?
>
> **a) 512px** (default) — good balance
>
> **b) 256px** — fast scans, fewer tokens
>
> **c) 768px / 1024px** — more detail, more tokens

Call `video_configure` with `frame_resolution`.

### Frame format
> Frame format?
>
> **a) jpeg** (default) — smallest
>
> **b) png** — lossless; better for screen recordings with text and sharp UI edges
>
> **c) webp** — smaller than png at similar quality

Call `video_configure` with `frame_format`.

## Step 4: Optional test

> Setup complete. Want to test it on a video? Give me a path to any local video file.

If they provide one, call `video_watch` and summarize briefly.

## Important

- Ask ONE question at a time
- Call `video_configure` after EACH answer so preferences are saved incrementally
- If the user says "just use defaults", skip straight to Step 4
- Never suggest installing ffmpeg, whisper.cpp, Python or an API key — none of them are used
