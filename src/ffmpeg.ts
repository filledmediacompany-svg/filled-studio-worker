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
  subtitle?: string;
}): Promise<void> {
  const { source, start, end, outPath, title, subtitle } = opts;
  const duration = end - start;
  const safe = escapeDrawText(title).slice(0, 80);
  const hasVideo = await sourceHasVideo(source);
  if (!hasVideo) {
    const titleLines = wrapText(title, 22, 3);
    const subtitleLines = wrapText(subtitle ?? "", 34, 2);
    const textFilters = [
      "[0:v]drawbox=x=48:y=785:w=624:h=260:color=black@0.48:t=fill[panel]",
      ...drawTextLines("panel", titleLines, "title", 80, 835, 40, "white", 50),
      ...drawTextLines(`title${Math.max(titleLines.length - 1, 0)}`, subtitleLines, "sub", 80, 995, 24, "0xE8D9A7", 34),
    ];
    const textOutput = subtitleLines.length > 0
      ? `sub${subtitleLines.length - 1}`
      : `title${Math.max(titleLines.length - 1, 0)}`;

    await execa("ffmpeg", [
      "-y",
      "-ss", String(start),
      "-t", String(duration),
      "-i", source,
      "-f", "lavfi",
      "-i", "color=c=#0a0a0a:s=720x1280:r=24",
      "-filter_complex",
      [
        "[1:v]drawbox=x=0:y=0:w=720:h=1280:color=0x16120D@0.35:t=fill[base]",
        "[base]drawbox=x=48:y=62:w=126:h=4:color=0xD7B56D@0.95:t=fill[accent]",
        "[accent]drawtext=text='FILLED STUDIO':fontcolor=0xD7B56D:fontsize=22:x=48:y=82[brand]",
        "[brand]drawbox=x=100:y=520:w=520:h=6:color=0xD7B56D@0.95:t=fill[bar1]",
        "[bar1]drawbox=x=140:y=548:w=440:h=6:color=0xD7B56D@0.55:t=fill[bar2]",
        "[bar2]drawbox=x=194:y=576:w=332:h=6:color=0xD7B56D@0.35:t=fill[audioMark]",
        ...textFilters.map((filter, index) => index === 0 ? filter.replace("[0:v]", "[audioMark]") : filter),
        `[${textOutput}]drawtext=text='AUDIO SOURCE':fontcolor=0xB8B8B8:fontsize=18:x=48:y=1185[v]`,
      ].join(";"),
      "-map", "[v]",
      "-map", "0:a:0",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ], { stdio: "inherit", timeout: Math.max(120000, duration * 10000), forceKillAfterDelay: 5000 });
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

function escapeDrawText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/['"\\:%]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = escapeDrawText(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function drawTextLines(
  inputLabel: string,
  lines: string[],
  outputPrefix: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  lineHeight: number,
): string[] {
  if (lines.length === 0) return [];

  return lines.map((line, index) => {
    const from = index === 0 ? inputLabel : `${outputPrefix}${index - 1}`;
    const to = `${outputPrefix}${index}`;
    return `[${from}]drawtext=text='${escapeDrawText(line)}':fontcolor=${color}:fontsize=${fontSize}:x=${x}:y=${y + index * lineHeight}[${to}]`;
  });
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
