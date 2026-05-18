import { promises as fs } from "fs";
import path from "path";
import { supabase, type Project, setStatus, setError } from "./supabase.js";
import { tmpDir, downloadYouTube, downloadFromSupabase, extractAudio, getDuration, renderClip } from "./ffmpeg.js";
import { transcribe } from "./transcribe.js";
import { detectClips } from "./ai.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
    await setStatus(project.id, "processing", { duration_seconds: Math.round(duration) });

    // 3. Audio + transcribe
    const audio = await extractAudio(srcPath, work);
    const transcript = await transcribe(audio);
    console.log(`[${project.id}] transcribed ${transcript.segments.length} segments`);

    await supabase.from("projects").update({
      transcript: { segments: transcript.segments, text: transcript.text.slice(0, 50000) },
    }).eq("id", project.id);

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

    // 5. Render each clip (sequential to keep memory low)
    for (const clip of insertedClips ?? []) {
      const outPath = path.join(work, `clip-${clip.id}.mp4`);
      try {
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
          status: "ready",
          output_url: pub.publicUrl,
        }).eq("id", clip.id);
        console.log(`[${project.id}] clip ${clip.id} ready`);
      } catch (e) {
        console.error(`[${project.id}] clip ${clip.id} failed`, e);
        await supabase.from("clips").update({ status: "failed" }).eq("id", clip.id);
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
