# Filled Studio — Render Worker

Polls the `projects` table for `status = 'queued'`, downloads the source (YouTube via `yt-dlp` or Supabase Storage upload), transcribes with OpenAI Whisper, detects viral clips via Lovable AI, then renders 9:16 MP4s with FFmpeg and uploads to the `renders` bucket.

## Deploy on Render

This repo includes `render.yaml` and a Dockerfile. The Docker image installs the native tools the worker needs at runtime: `ffmpeg`, `ffprobe`, `python3`, `pip3`, fonts, and `yt-dlp`.

1. Create a Render Blueprint from this GitHub repo, or create a Web Service using the Docker runtime.
2. Add these secret env vars in Render:

| Variable | Value |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase Project Settings -> API |
| `OPENAI_API_KEY` | your OpenAI key for transcription |
| `LOVABLE_API_KEY` | optional; from Lovable Cloud -> AI Gateway. If omitted, clip detection uses OpenAI. |
| `CLIP_DETECTION_MODEL` | optional; defaults to `gpt-4o-mini` |

3. Confirm `SUPABASE_URL` is `https://abzfjfcfigshlkwgwdpy.supabase.co`.
4. Deploy. `/health` should return `{ "ok": true, ... }`.

## Deploy on Railway

1. Create a new Railway project → "Deploy from GitHub" (push this `worker/` folder to a repo) **or** "Empty service" → upload zip.
2. Railway uses `railpack.json` for Node plus native runtime packages.
3. Add these env vars (Service → Variables):

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://abzfjfcfigshlkwgwdpy.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Lovable Cloud → Backend → API keys |
| `OPENAI_API_KEY` | your OpenAI key (Whisper) |
| `LOVABLE_API_KEY` | optional; from Lovable Cloud → AI Gateway. If omitted, clip detection uses OpenAI. |
| `CLIP_DETECTION_MODEL` | `gpt-4o-mini` (optional) |
| `POLL_INTERVAL_MS` | `5000` (optional) |

4. Deploy. Watch logs — it should print `Filled Studio worker started.`
5. Create a project in the app. The worker claims it within ~5s, runs the pipeline, and writes clips to your `renders` bucket.

## Local dev

```bash
cd worker
cp .env.example .env   # fill in keys
npm install
npm run dev
```

Requires local `ffmpeg`, `ffprobe`, `yt-dlp`, and `python3` on your PATH.

## Pipeline

```
queued → claim → download (yt-dlp or storage)
       → ffmpeg extract audio → Whisper transcribe
       → Lovable AI detect 5 viral clips
       → ffmpeg render each clip (9:16, burned-in title)
       → upload to renders bucket → status=ready
```

## Next slices (when ready)

- Word-synced caption overlays (ASS subtitle generation from Whisper word timestamps)
- B-roll auto-injection (read `clip_broll` rows, overlay with crossfade)
- Background music ducking
- Multiple caption presets (Filled Cinematic, Hormozi, Iman Gadzhi-style)
