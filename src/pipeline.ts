import { promises as fs } from "fs";
import path from "path";
import { supabase, type Project, setStatus, setError } from "./supabase.js";
import { tmpDir, downloadYouTube, downloadFromSupabase, extractAudio, getDuration, renderClip } from "./ffmpeg.js";
import { transcribe } from "./transcribe.js";
import { detectClips, type DetectedClip } from "./ai.js";

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

    // 5. Render each clip (sequential to keep memory low)
    for (const clip of insertedClips ?? []) {
      const outPath = path.join(work, `clip-${clip.id}.mp4`);
      try {
        await createRenderJob(clip.id, project.id, project.user_id, "processing");
        await renderClip({
          source: srcPath,
          start: Number(clip.start_seconds),
          end: Number(clip.end_seconds),
          outPath,
          title: clip.title,
        });
        // Upload
        const buf = await fs.readFile(outPath);
        const key = `${project.user_id}/${project.id}/${clip.id}.mp4`;
        const { error: upErr } = await supabase.storage.from("renders").upload(key, buf, {
          contentType: "video/mp4",
          upsert: true,
        });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from("renders").getPublicUrl(key);
        await supabase.from("clips").update({
          status: "rendered",
          output_url: pub.publicUrl,
        }).eq("id", clip.id);
        await finishRenderJob(clip.id, "ready", pub.publicUrl);
        console.log(`[${project.id}] clip ${clip.id} ready`);
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

async function persistTranscriptWords(
  project: Project,
  words: Array<{ word: string; start: number; end: number }>,
): Promise<void> {
  if (words.length === 0) return;

  for (let i = 0; i < words.length; i += WORD_BATCH_SIZE) {
    const rows = words.slice(i, i + WORD_BATCH_SIZE).map((word, index) => ({
      project_id: project.id,
      user_id: project.user_id,
      word_index: i + index,
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
    project_id: projectId,
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
    progress: status === "ready" ? 100 : 0,
    output_url: outputUrl,
    error_message: errorMessage?.slice(0, 500) ?? null,
  };
  const { error } = await supabase.from("render_jobs").update(fields).eq("clip_id", clipId);
  if (error) {
    console.warn(`[clip ${clipId}] render_jobs update skipped: ${error.message}`);
  }
}
