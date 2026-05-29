import { promises as fs } from "fs";
import path from "path";
import { supabase, type Project, type RenderJob, setStatus, setError } from "./supabase.js";
import { tmpDir, downloadYouTube, downloadFromSupabase, extractAudio, getDuration, renderClip } from "./ffmpeg.js";
import { transcribe } from "./transcribe.js";
import { detectClips, type DetectedClip } from "./ai.js";
import { prepareBrollAssets } from "./broll.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORD_BATCH_SIZE = 500;

export async function processProject(project: Project): Promise<void> {
  console.log(`[${project.id}] start: ${project.title}`);
  const work = await tmpDir(`proj-${project.id}-`);

  try {
    // 1. Acquire source
    let srcPath: string;
    if (project.source_type === "youtube") {
      if (!project.source_url) throw new Error("missing source_url");
      srcPath = await downloadYouTube(project.source_url, work);
    } else {
      if (!project.source_storage_key) throw new Error("missing source_storage_key");
      srcPath = await downloadFromSupabase(SUPABASE_URL, SERVICE_KEY, "uploads", project.source_storage_key, work);
    }
    console.log(`[${project.id}] source ready: ${srcPath}`);

    // 2. Probe duration
    const duration = await getDuration(srcPath);
    await setStatus(project.id, "transcribing", { duration_seconds: Math.round(duration) });

    // 3. Audio + transcribe
    const audio = await extractAudio(srcPath, work);
    const transcript = await transcribe(audio);
    console.log(`[${project.id}] transcribed ${transcript.segments.length} segments`);

    await supabase.from("projects").update({
      transcript: { segments: transcript.segments, text: transcript.text.slice(0, 50000) },
    }).eq("id", project.id);
    await persistTranscriptWords(project, transcript.words);

    // 4. AI clip detection
    await setStatus(project.id, "detecting_clips");
    const detected = await detectClips(transcript.text, duration);
    console.log(`[${project.id}] detected ${detected.length} clips`);

    const clipRows = detected.map((c) => ({
      project_id: project.id,
      user_id: project.user_id,
      title: c.title,
      hook: c.hook,
      start_seconds: c.start_seconds,
      end_seconds: c.end_seconds,
      virality_score: Math.round(c.virality_score),
      status: "rendering" as const,
    }));
    const { data: insertedClips, error: insErr } = await supabase.from("clips").insert(clipRows).select();
    if (insErr) throw insErr;
    await persistClipStudioFields(insertedClips ?? [], detected);
    await setStatus(project.id, "ready");
    const detectedByClipId = new Map(
      (insertedClips ?? []).map((clip, index) => [clip.id, detected[index]]),
    );

    // 5. Render each clip (sequential to keep memory low)
    for (const clip of insertedClips ?? []) {
      const sourceClip = detectedByClipId.get(clip.id);
      const outPath = path.join(work, `clip-${clip.id}.mp4`);
      try {
        await createRenderJob(clip.id, project.id, project.user_id, "running");
        const recipe = clip.controls?.edit_recipe ?? buildDefaultEditRecipe(clip, sourceClip?.transcript_excerpt || sourceClip?.hook);
        const brollAssets = await prepareBrollAssets({
          recipe,
          clipId: clip.id,
          userId: project.user_id,
          clipStart: Number(clip.start_seconds),
          clipEnd: Number(clip.end_seconds),
          workDir: work,
        });
        await renderClip({
          source: srcPath,
          start: Number(clip.start_seconds),
          end: Number(clip.end_seconds),
          outPath,
          title: clip.title,
          subtitle: sourceClip?.transcript_excerpt || sourceClip?.hook,
          recipe,
          brollAssets,
        });
        // Upload
        const buf = await fs.readFile(outPath);
        const key = `${project.user_id}/${project.id}/${clip.id}.mp4`;
        const { error: upErr } = await supabase.storage.from("renders").upload(key, buf, {
          contentType: "video/mp4",
          cacheControl: "60",
          upsert: true,
        });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from("renders").getPublicUrl(key);
        await supabase.from("clips").update({
          status: "rendered",
          output_url: pub.publicUrl,
        }).eq("id", clip.id);
        await finishRenderJob(clip.id, "completed", pub.publicUrl);
        console.log(`[${project.id}] clip ${clip.id} rendered`);
      } catch (e) {
        console.error(`[${project.id}] clip ${clip.id} failed`, e);
        await supabase.from("clips").update({ status: "failed" }).eq("id", clip.id);
        await finishRenderJob(clip.id, "failed", null, e instanceof Error ? e.message : String(e));
      }
    }

    await setStatus(project.id, "ready");
    console.log(`[${project.id}] done`);
  } catch (e) {
    console.error(`[${project.id}] FAILED`, e);
    await setError(project.id, e instanceof Error ? e.message : String(e));
  } finally {
    // Cleanup tmp
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function processRenderJob(job: RenderJob): Promise<void> {
  const work = await tmpDir(`render-${job.id}-`);
  console.log(`[render job ${job.id}] start`);

  try {
    const { data: clip, error: clipError } = await supabase
      .from("clips")
      .select("*")
      .eq("id", job.clip_id)
      .single();
    if (clipError || !clip) throw clipError ?? new Error("Clip not found");

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", clip.project_id)
      .single();
    if (projectError || !project) throw projectError ?? new Error("Project not found");

    let srcPath: string;
    if (project.source_type === "youtube") {
      if (!project.source_url) throw new Error("missing source_url");
      srcPath = await downloadYouTube(project.source_url, work);
    } else {
      if (!project.source_storage_key) throw new Error("missing source_storage_key");
      srcPath = await downloadFromSupabase(SUPABASE_URL, SERVICE_KEY, "uploads", project.source_storage_key, work);
    }

    await updateRenderJob(job.id, { progress: 30 });
    const outPath = path.join(work, `clip-${clip.id}.mp4`);
    const recipe = clip.controls?.edit_recipe ?? buildDefaultEditRecipe(clip, clip.transcript_excerpt || clip.hook);
    const brollAssets = await prepareBrollAssets({
      recipe,
      clipId: clip.id,
      userId: project.user_id,
      clipStart: Number(clip.start_seconds),
      clipEnd: Number(clip.end_seconds),
      workDir: work,
    });
    await updateRenderJob(job.id, { progress: brollAssets.length > 0 ? 45 : 35 });
    await renderClip({
      source: srcPath,
      start: Number(clip.start_seconds),
      end: Number(clip.end_seconds),
      outPath,
      title: clip.title,
      subtitle: clip.transcript_excerpt || clip.hook,
      recipe,
      brollAssets,
    });

    await updateRenderJob(job.id, { progress: 75 });
    const buf = await fs.readFile(outPath);
    const key = `${project.user_id}/${project.id}/${clip.id}-${job.id}.mp4`;
    const { error: uploadError } = await supabase.storage.from("renders").upload(key, buf, {
      contentType: "video/mp4",
      cacheControl: "60",
      upsert: true,
    });
    if (uploadError) throw uploadError;

    const { data: pub } = supabase.storage.from("renders").getPublicUrl(key);
    await supabase
      .from("clips")
      .update({ status: "rendered", output_url: pub.publicUrl })
      .eq("id", clip.id);
    await finishRenderJobById(job.id, "completed", pub.publicUrl);
    await supabase
      .from("render_jobs")
      .update({ status: "completed", progress: 100, output_url: pub.publicUrl, completed_at: new Date().toISOString() })
      .eq("clip_id", clip.id)
      .eq("status", "queued");
    console.log(`[render job ${job.id}] completed clip ${clip.id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[render job ${job.id}] failed`, error);
    await supabase.from("clips").update({ status: "failed" }).eq("id", job.clip_id);
    await finishRenderJobById(job.id, "failed", null, message);
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function persistTranscriptWords(
  project: Project,
  words: Array<{ word: string; start: number; end: number }>,
): Promise<void> {
  if (words.length === 0) return;

  const { error: deleteError } = await supabase.from("transcript_words").delete().eq("project_id", project.id);
  if (deleteError) {
    console.warn(`[${project.id}] transcript_words delete skipped: ${deleteError.message}`);
  }

  for (let i = 0; i < words.length; i += WORD_BATCH_SIZE) {
    const rows = words.slice(i, i + WORD_BATCH_SIZE).map((word, index) => ({
      project_id: project.id,
      user_id: project.user_id,
      position: i + index,
      word: word.word,
      start_seconds: word.start,
      end_seconds: word.end,
    }));
    const { error } = await supabase.from("transcript_words").insert(rows);
    if (error) {
      console.warn(`[${project.id}] transcript_words insert skipped: ${error.message}`);
      return;
    }
  }
  console.log(`[${project.id}] persisted ${words.length} transcript words`);
}

async function persistClipStudioFields(insertedClips: any[], detected: DetectedClip[]): Promise<void> {
  for (let i = 0; i < insertedClips.length; i += 1) {
    const clip = insertedClips[i];
    const source = detected[i];
    if (!clip?.id || !source) continue;

    const { error } = await supabase
      .from("clips")
      .update({
        hook_score: Math.round(source.hook_score ?? source.virality_score),
        retention_score: Math.round(source.retention_score ?? source.virality_score),
        transcript_excerpt: source.transcript_excerpt || source.hook,
      })
      .eq("id", clip.id);
    if (error) {
      console.warn(`[${clip.project_id ?? "clip"}] clip studio field update skipped: ${error.message}`);
      return;
    }
  }
}

async function createRenderJob(clipId: string, projectId: string, userId: string, status: string): Promise<void> {
  const { error } = await supabase.from("render_jobs").insert({
    clip_id: clipId,
    user_id: userId,
    status,
    progress: 0,
  });
  if (error) {
    console.warn(`[${projectId}] render_jobs insert skipped: ${error.message}`);
  }
}

async function finishRenderJob(
  clipId: string,
  status: string,
  outputUrl: string | null,
  errorMessage?: string,
): Promise<void> {
  const fields: Record<string, unknown> = {
    status,
    progress: status === "completed" ? 100 : 0,
    output_url: outputUrl,
    error_message: errorMessage?.slice(0, 500) ?? null,
  };
  const { error } = await supabase.from("render_jobs").update(fields).eq("clip_id", clipId);
  if (error) {
    console.warn(`[clip ${clipId}] render_jobs update skipped: ${error.message}`);
  }
}

function buildDefaultEditRecipe(clip: any, text?: string): Record<string, unknown> {
  const start = Number(clip.start_seconds ?? 0);
  const end = Number(clip.end_seconds ?? start + 35);
  const duration = Math.max(8, end - start);
  const excerpt = String(text || clip.hook || clip.title || "podcast interview breakthrough moment");
  const brollCount = Math.max(5, Math.min(8, Math.round(duration / 6)));
  return {
    id: `worker-bryce:${clip.id ?? "clip"}`,
    presetId: "bryce_punchy",
    label: "Bryce Punchy",
    intensity: 94,
    hookStrategy: "pattern interrupt",
    caption: {
      mode: "kinetic",
      maxWords: 2,
      emphasis: "every beat",
      transition: "pop + snap",
    },
    cameraMoves: [
      { at: start + Math.min(1.1, duration * 0.1), type: "punch-in", scale: 1.22, reason: "hook emphasis" },
      { at: start + duration * 0.38, type: "jump reframe", scale: 1.18, reason: "idea turn" },
      { at: start + duration * 0.68, type: "snap zoom", scale: 1.24, reason: "payoff line" },
    ],
    brollSlots: buildDefaultBrollSlots(excerpt, start, end, brollCount),
    soundDesign: {
      style: "impact",
      cues: [
        { at: start + Math.min(1.1, duration * 0.1), type: "impact hit" },
        { at: start + duration * 0.68, type: "whoosh" },
      ],
    },
  };
}

function buildDefaultBrollSlots(text: string, clipStart: number, clipEnd: number, count: number) {
  const duration = Math.max(1, clipEnd - clipStart);
  const phrases = text.replace(/\s+/g, " ").split(/[,.!?]/).map((part) => part.trim()).filter(Boolean);
  return Array.from({ length: count }).map((_, index) => {
    const start = clipStart + duration * ((index + 0.75) / (count + 1.2));
    const phrase = phrases[index % Math.max(phrases.length, 1)] || text;
    return {
      start,
      end: Math.min(clipEnd, start + Math.min(3.8, Math.max(2.2, duration / 7))),
      prompt: buildBrollSearchPrompt(phrase),
      reason: "automatic visual pattern break",
    };
  });
}

function buildBrollSearchPrompt(value: string): string {
  const lower = value.toLowerCase();
  if (/\b(god|faith|church|pray|prayer|spiritual|sermon|worship)\b/.test(lower)) return "cinematic church worship prayer";
  if (/\b(business|company|work|money|career|founder|market|sales|client)\b/.test(lower)) return "cinematic entrepreneur office work";
  if (/\b(anxiety|fear|alone|depressed|stress|mental|emotion|pain|overwhelmed)\b/.test(lower)) return "cinematic person thinking alone";
  if (/\b(family|mother|father|kid|child|home|relationship|marriage)\b/.test(lower)) return "cinematic family home";
  if (/\b(health|body|fitness|doctor|hospital|sleep|brain|therapy)\b/.test(lower)) return "cinematic health lifestyle";
  if (/\b(podcast|interview|conversation|talk|microphone)\b/.test(lower)) return "podcast interview studio";
  const keywords = lower
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !DEFAULT_BROLL_STOPWORDS.has(word))
    .slice(0, 4);
  return keywords.length ? `cinematic ${keywords.join(" ")}` : "cinematic documentary people";
}

const DEFAULT_BROLL_STOPWORDS = new Set([
  "that", "this", "with", "from", "have", "there", "their", "about", "what", "when", "were", "your", "they", "just",
  "like", "think", "know", "because", "really", "going", "would", "could", "should", "thing", "things", "people",
  "into", "onto", "then", "than", "them", "very", "more", "most", "some", "only", "also", "been",
]);

async function updateRenderJob(jobId: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("render_jobs").update(fields).eq("id", jobId);
  if (error) console.warn(`[render job ${jobId}] update skipped: ${error.message}`);
}

async function finishRenderJobById(
  jobId: string,
  status: string,
  outputUrl: string | null,
  errorMessage?: string,
): Promise<void> {
  await updateRenderJob(jobId, {
    status,
    progress: status === "completed" ? 100 : 0,
    output_url: outputUrl,
    error_message: errorMessage?.slice(0, 500) ?? null,
    completed_at: new Date().toISOString(),
  });
}
