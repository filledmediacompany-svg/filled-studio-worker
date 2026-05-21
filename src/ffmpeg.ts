import { execa } from "execa";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export async function tmpDir(prefix = "fs-"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function downloadYouTube(url: string, outDir: string): Promise<string> {
  const out = path.join(outDir, "source.%(ext)s");
  const commonArgs = [
    "--no-playlist",
    "--retries", "3",
    "--fragment-retries", "3",
    "--merge-output-format", "mp4",
    "-o", out,
  ];

  try {
    await execa("yt-dlp", [
      "-f", "bv*[height<=1080]+ba/b[height<=1080]/best",
      ...commonArgs,
      url,
    ], { stderr: "pipe", stdout: "pipe" });
  } catch (primaryError) {
    try {
      await execa("yt-dlp", [
        "-f", "best",
        ...commonArgs,
        url,
      ], { stderr: "pipe", stdout: "pipe" });
    } catch (fallbackError) {
      const message = formatDownloadError(fallbackError, primaryError);
      throw new Error(`YouTube download failed: ${message}`);
    }
  }

  // Find the file
  const files = await fs.readdir(outDir);
  const src = files.find((f) => f.startsWith("source."));
  if (!src) throw new Error("yt-dlp produced no file");
  return path.join(outDir, src);
}

function formatDownloadError(error: unknown, primaryError?: unknown): string {
  const stderr = [error, primaryError]
    .map((value) => {
      if (!value || typeof value !== "object") return "";
      const maybe = value as { stderr?: string; shortMessage?: string; message?: string };
      return maybe.stderr || maybe.shortMessage || maybe.message || "";
    })
    .filter(Boolean)
    .join("\n");

  return stderr.split("\n").slice(-8).join("\n").trim() || "yt-dlp exited without details";
}

export async function downloadFromSupabase(supabaseUrl: string, serviceKey: string, bucket: string, key: string, outDir: string): Promise<string> {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodedKey}`, {
    headers: { Authorization: `Bearer ${serviceKey}` },
  });
  if (!r.ok) throw new Error(`Storage download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const out = path.join(outDir, path.basename(key));
  await fs.writeFile(out, buf);
  return out;
}

export async function extractAudio(videoPath: string, outDir: string): Promise<string> {
  const out = path.join(outDir, "audio.mp3");
  await execa("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out], { stdio: "inherit" });
  return out;
}

export async function getDuration(videoPath: string): Promise<number> {
  const { stdout } = await execa("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath]);
  return parseFloat(stdout.trim());
}

/**
 * Render a vertical 9:16 short clip with burned-in captions and optional B-roll overlay.
 * Captions: drawtext at bottom-third, gold accent, large display font.
 */
export async function renderClip(opts: {
  source: string;
  start: number;
  end: number;
  outPath: string;
  title: string;
}): Promise<void> {
  const { source, start, end, outPath, title } = opts;
  const duration = end - start;
  // Title escape for drawtext
  const safe = title.replace(/['"\\':\%]/g, " ").slice(0, 80);
  const hasVideo = await sourceHasVideo(source);
  if (!hasVideo) {
    await execa("ffmpeg", [
      "-y",
      "-ss", String(start),
      "-t", String(duration),
      "-i", source,
      "-f", "lavfi",
      "-i", "color=c=#0a0a0a:s=1080x1920:r=30",
      "-filter_complex",
      `[1:v]drawtext=text='${safe}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.6:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2[v]`,
      "-map", "[v]",
      "-map", "0:a",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ], { stdio: "inherit" });
    return;
  }

  const filter = [
    `[0:v]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS,`,
    `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,`,
    `drawtext=text='${safe}':fontcolor=white:fontsize=64:box=1:boxcolor=black@0.6:boxborderw=20:x=(w-text_w)/2:y=h-360`,
    `[v]`,
  ].join("");
  await execa("ffmpeg", [
    "-y",
    "-i", source,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", `0:a`,
    "-ss", String(start),
    "-t", String(duration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ], { stdio: "inherit" });
}

async function sourceHasVideo(source: string): Promise<boolean> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    source,
  ]);
  return stdout.trim() === "video";
}
