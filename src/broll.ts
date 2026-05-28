import { promises as fs } from "fs";
import path from "path";
import { supabase } from "./supabase.js";

export type BrollSlot = {
  start: number;
  end: number;
  prompt: string;
  reason?: string;
};

export type BrollAsset = BrollSlot & {
  path: string;
  source: string;
  sourceUrl: string;
  thumbnailUrl?: string | null;
};

type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  duration: number;
  image?: string;
  video_files: Array<{
    link: string;
    quality?: string;
    width?: number;
    height?: number;
    file_type?: string;
  }>;
};

export async function prepareBrollAssets(opts: {
  recipe: Record<string, any> | null | undefined;
  clipId: string;
  userId: string;
  clipStart: number;
  clipEnd: number;
  workDir: string;
}): Promise<BrollAsset[]> {
  const slots = normalizeSlots(opts.recipe?.brollSlots, opts.clipStart, opts.clipEnd);
  if (slots.length === 0) return [];

  const assets: BrollAsset[] = [];

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const asset = await findPexelsAsset(slot, opts.workDir, index);
    if (!asset) continue;

    assets.push(asset);
  }

  if (assets.length === 0) return [];

  await supabase.from("clip_broll").delete().eq("clip_id", opts.clipId);
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    await supabase.from("clip_broll").insert({
      clip_id: opts.clipId,
      user_id: opts.userId,
      start_seconds: opts.clipStart + asset.start,
      end_seconds: opts.clipStart + asset.end,
      position: index,
      source: asset.source,
      source_url: asset.sourceUrl,
      thumbnail_url: asset.thumbnailUrl ?? null,
      treatment: {
        prompt: asset.prompt,
        reason: asset.reason ?? null,
        render: "full-frame-overlay",
      },
    });
  }

  return assets;
}

function normalizeSlots(value: unknown, clipStart: number, clipEnd: number): BrollSlot[] {
  if (!Array.isArray(value)) return [];
  const duration = Math.max(1, clipEnd - clipStart);

  return value
    .map((slot): BrollSlot | null => {
      if (!slot || typeof slot !== "object") return null;
      const item = slot as Record<string, unknown>;
      const prompt = String(item.prompt ?? item.query ?? "").trim();
      if (!prompt) return null;

      const rawStart = Number(item.start ?? item.start_seconds ?? 0);
      const rawEnd = Number(item.end ?? item.end_seconds ?? rawStart + 2.5);
      const relativeStart = rawStart >= clipStart ? rawStart - clipStart : rawStart;
      const relativeEnd = rawEnd > clipStart ? rawEnd - clipStart : rawEnd;
      const start = clamp(relativeStart, 0, Math.max(0, duration - 0.8));
      const end = clamp(Math.max(relativeEnd, start + 1.6), start + 0.8, duration);

      return {
        start,
        end,
        prompt,
        reason: typeof item.reason === "string" ? item.reason : undefined,
      };
    })
    .filter((slot): slot is BrollSlot => Boolean(slot))
    .slice(0, 4);
}

async function findPexelsAsset(slot: BrollSlot, workDir: string, index: number): Promise<BrollAsset | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn(`[broll] PEXELS_API_KEY missing; rendering without real B-roll for "${slot.prompt}"`);
    return null;
  }

  const url = new URL("https://api.pexels.com/v1/videos/search");
  url.searchParams.set("query", slot.prompt);
  url.searchParams.set("per_page", "8");
  url.searchParams.set("orientation", "portrait");

  try {
    const response = await fetch(url, { headers: { Authorization: apiKey } });
    if (!response.ok) {
      console.warn(`[broll] Pexels search failed ${response.status} for "${slot.prompt}"`);
      return null;
    }

    const json = (await response.json()) as { videos?: PexelsVideo[] };
    const video = chooseVideo(json.videos ?? []);
    const file = chooseFile(video);
    if (!video || !file?.link) return null;

    const outPath = path.join(workDir, `broll-${index}.mp4`);
    await downloadFile(file.link, outPath);
    return {
      ...slot,
      path: outPath,
      source: "pexels",
      sourceUrl: `https://www.pexels.com/video/${video.id}/`,
      thumbnailUrl: video.image ?? null,
    };
  } catch (error) {
    console.warn(`[broll] failed for "${slot.prompt}"`, error);
    return null;
  }
}

function chooseVideo(videos: PexelsVideo[]): PexelsVideo | null {
  return videos
    .filter((video) => video.video_files?.length)
    .sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] ?? null;
}

function scoreVideo(video: PexelsVideo): number {
  const portrait = video.height > video.width ? 1000 : 0;
  const usefulDuration = video.duration >= 3 && video.duration <= 30 ? 300 : 0;
  return portrait + usefulDuration + Math.min(video.height, 1920);
}

function chooseFile(video: PexelsVideo | null): PexelsVideo["video_files"][number] | null {
  if (!video) return null;
  return [...video.video_files]
    .filter((file) => (file.file_type ?? "").includes("mp4") || file.link.includes(".mp4"))
    .sort((a, b) => scoreFile(b) - scoreFile(a))[0] ?? video.video_files[0] ?? null;
}

function scoreFile(file: PexelsVideo["video_files"][number]): number {
  const width = Number(file.width ?? 0);
  const height = Number(file.height ?? 0);
  const portrait = height >= width ? 1000 : 0;
  const targetHeight = Math.min(Math.abs(height - 1280), 1280);
  return portrait + height - targetHeight * 0.25;
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`B-roll download failed ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outPath, buffer);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
