import { execa } from "execa";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { BrollAsset } from "./broll.js";

export type CaptionWord = {
  word: string;
  start: number;
  end: number;
};

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
  recipe?: Record<string, any> | null;
  brollAssets?: BrollAsset[];
  captionWords?: CaptionWord[];
}): Promise<void> {
  const { source, start, end, outPath, title, subtitle, recipe, brollAssets = [], captionWords = [] } = opts;
  const duration = end - start;
  const recipePreset = typeof recipe?.presetId === "string" ? recipe.presetId : "basic";
  const intensity = Number(recipe?.intensity ?? 45);
  const hasVideo = await sourceHasVideo(source);
  if (!hasVideo) {
    const titleLines = wrapText(title, 22, 3);
    const subtitleLines = wrapText(subtitle ?? "", 34, 2);
    const textFilters = [
      ...drawTextLines("audioMark", titleLines, "title", 80, 835, 40, "white", 50),
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
        ...textFilters,
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

  const caption = escapeDrawText(subtitle || title).slice(0, 110);
  const captionLines = wrapText(caption, recipePreset === "bryce_punchy" ? 18 : 24, 2);
  const baseFilters = [
    "scale=720:1280:force_original_aspect_ratio=increase",
    "crop=720:1280",
    buildSteppedPunchScale(recipePreset, intensity),
    "crop=720:1280",
    "eq=contrast=1.08:saturation=1.12",
    "unsharp=5:5:0.65:3:3:0.25",
  ];
  const assPath = await writeAssCaptions({
    words: captionWords,
    fallback: subtitle || title,
    outDir: path.dirname(outPath),
    duration,
    presetId: recipePreset,
  });
  const captionFilters = assPath
    ? [`subtitles=${escapeFilterPath(assPath)}`]
    : drawBurnedCaptionFilters(captionLines, recipePreset, intensity);
  const safeBroll = brollAssets
    .filter((asset) => Number.isFinite(asset.start) && Number.isFinite(asset.end) && asset.end > asset.start)
    .slice(0, 8);

  if (safeBroll.length > 0) {
    const inputs = safeBroll.flatMap((asset) => ["-stream_loop", "-1", "-i", asset.path]);
    const filter = buildBrollFilterComplex(baseFilters, captionFilters, safeBroll);

    await execa("ffmpeg", [
      "-y",
      "-ss", String(start),
      "-t", String(duration),
      "-i", source,
      ...inputs,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "0:a:0?",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "25",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      outPath,
    ], { stdio: "inherit", timeout: Math.max(120000, duration * 12000), forceKillAfterDelay: 5000 });
    return;
  }

  await execa("ffmpeg", [
    "-y",
    "-ss", String(start),
    "-t", String(duration),
    "-i", source,
    "-vf",
    [...baseFilters, ...captionFilters].join(","),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ], { stdio: "inherit", timeout: Math.max(120000, duration * 10000), forceKillAfterDelay: 5000 });
}

function buildBrollFilterComplex(baseFilters: string[], captionFilters: string[], assets: BrollAsset[]): string {
  const filters: string[] = [
    `[0:v]${baseFilters.join(",")}[base0]`,
  ];
  let current = "base0";

  assets.forEach((asset, index) => {
    const input = index + 1;
    const start = Math.max(0, asset.start);
    const end = Math.max(start + 0.5, asset.end);
    const duration = end - start;
    const fadeOutStart = Math.max(start, end - 0.18);
    const brollLabel = `broll${index}`;
    const outLabel = `mix${index}`;
    filters.push(
      `[${input}:v]trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB,scale=820:1458:force_original_aspect_ratio=increase,crop=720:1280,eq=contrast=1.1:saturation=1.16,unsharp=5:5:0.55:3:3:0.2,format=yuva420p,fade=t=in:st=${start.toFixed(3)}:d=0.08:alpha=1,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.14:alpha=1[${brollLabel}]`,
      `[${current}][${brollLabel}]overlay=0:0:eof_action=pass:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${outLabel}]`,
    );
    current = outLabel;
  });

  filters.push(`[${current}]${captionFilters.join(",")}[v]`);
  return filters.join(";");
}

function buildSteppedPunchScale(presetId: string, intensity: number): string {
  const base = presetId === "doac_clean" ? 1.045 : presetId === "bryce_punchy" ? 1.12 : 1.08;
  const punch = presetId === "doac_clean" ? 0.035 : Math.max(0.07, Math.min(0.14, intensity / 800));
  const expr = `${base.toFixed(3)}+${punch.toFixed(3)}*between(mod(t,4.0),0.0,0.34)+${(punch * 0.65).toFixed(3)}*between(mod(t,4.0),1.55,1.9)+${(punch * 0.85).toFixed(3)}*between(mod(t,4.0),2.85,3.16)`;
  return `scale=w='720*(${expr})':h='1280*(${expr})':eval=frame`;
}

async function writeAssCaptions(opts: {
  words: CaptionWord[];
  fallback: string;
  outDir: string;
  duration: number;
  presetId: string;
}): Promise<string | null> {
  const phrases = buildCaptionPhrases(opts.words, opts.duration, opts.presetId === "bryce_punchy" ? 2 : 3);
  if (phrases.length === 0) {
    const fallback = escapeAssText(opts.fallback).trim();
    if (!fallback) return null;
    phrases.push({ start: 0, end: Math.min(opts.duration, 2.8), text: fallback.split(/\s+/).slice(0, 5).join(" ") });
  }

  const assPath = path.join(opts.outDir, "captions.ass");
  const primary = opts.presetId === "bryce_punchy" ? "&H004BC8F2" : "&H00FFFFFF";
  const body = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 720",
    "PlayResY: 1280",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Punch,Arial,62,${primary},&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,3,2,38,38,260,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...phrases.map((phrase) => {
      const text = escapeAssText(phrase.text.toUpperCase());
      const line = `{\\an2\\pos(360,965)\\fad(35,70)\\t(0,110,\\fscx116\\fscy116)\\t(110,250,\\fscx100\\fscy100)}${text}`;
      return `Dialogue: 0,${formatAssTime(phrase.start)},${formatAssTime(phrase.end)},Punch,,0,0,0,,${line}`;
    }),
  ].join("\n");

  await fs.writeFile(assPath, body, "utf8");
  return assPath;
}

function buildCaptionPhrases(words: CaptionWord[], duration: number, maxWords: number): Array<{ start: number; end: number; text: string }> {
  const safeWords = words
    .map((word) => ({
      word: word.word.trim(),
      start: Math.max(0, word.start),
      end: Math.min(duration, Math.max(word.start + 0.12, word.end)),
    }))
    .filter((word) => word.word && word.end > 0 && word.start < duration)
    .sort((a, b) => a.start - b.start);

  const phrases: Array<{ start: number; end: number; text: string }> = [];
  for (let index = 0; index < safeWords.length; index += maxWords) {
    const group = safeWords.slice(index, index + maxWords);
    phrases.push({
      start: group[0].start,
      end: Math.min(duration, Math.max(group[group.length - 1].end + 0.08, group[0].start + 0.42)),
      text: group.map((word) => word.word).join(" "),
    });
  }
  return phrases;
}

function formatAssTime(value: number): string {
  const totalCentiseconds = Math.max(0, Math.round(value * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAssText(value: string): string {
  return value.replace(/[{}]/g, "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function drawBurnedCaptionFilters(lines: string[], presetId: string, intensity: number): string[] {
  const fontSize = presetId === "doac_clean" ? 38 : presetId === "bryce_punchy" ? 48 : 43;
  const yBase = presetId === "doac_clean" ? "h-265" : "h-300";
  const color = presetId === "bryce_punchy" ? "0xF2C84B" : "white";
  const border = presetId === "doac_clean" ? 3 : Math.max(4, Math.min(8, Math.round(intensity / 13)));
  const safeLines = lines.length > 0 ? lines : [" "];

  return safeLines.map((line, index) => {
    const y = `${yBase}+${index * (fontSize + 8)}`;
    return [
      "drawtext=",
      `text='${escapeDrawText(line)}'`,
      `fontcolor=${index === 0 ? color : "white"}`,
      `fontsize=${fontSize}`,
      `borderw=${border}`,
      "bordercolor=black@0.92",
      "shadowcolor=black@0.85",
      "shadowx=3",
      "shadowy=3",
      "x=(w-text_w)/2",
      `y=${y}`,
    ].join(":");
  });
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
