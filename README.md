# Filled Studio — Render Worker

Polls the `projects` table for `status = 'queued'`, downloads the source (YouTube via `yt-dlp` or Supabase Storage upload), transcribes with OpenAI Whisper, detects viral clips via Lovable AI, then renders 9:16 MP4s with FFmpeg and uploads to the `renders` bucket.

## Deploy on Railway

1. Create a new Railway project → "Deploy from GitHub" (push this `worker/` folder to a repo) **or** "Empty service" → upload zip.
2. Railway auto-detects the `Dockerfile`.
3. Add these env vars (Service → Variables):

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | `https://qltmbelnvxcjhtzjrjgy.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | from Lovable Cloud → Backend → API keys |
| `LOVABLE_API_KEY` | from Lovable Cloud → AI Gateway |
| `OPENAI_API_KEY` | your OpenAI key (Whisper) |
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
