import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://abzfjfcfigshlkwgwdpy.supabase.co";
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const missingSupabaseEnv = [
  SUPABASE_URL ? null : "SUPABASE_URL",
  SUPABASE_SERVICE_ROLE_KEY ? null : "SUPABASE_SERVICE_ROLE_KEY",
].filter((key): key is string => Boolean(key));

export const isSupabaseConfigured = missingSupabaseEnv.length === 0;

if (!isSupabaseConfigured) {
  console.error("Missing Supabase credentials. Worker will stay healthy but paused until configured.");
  console.error("SUPABASE_URL:", SUPABASE_URL ? "set" : "missing");
  console.error("SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing");
  console.error(
    "Visible Supabase/database environment variables:",
    Object.keys(process.env).filter((key) => key.includes("SUPABASE") || key.includes("DATABASE")).sort(),
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ?? "missing-service-role-key", {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type Project = {
  id: string;
  user_id: string;
  title: string;
  source_type: "youtube" | "upload";
  source_url: string | null;
  source_storage_key: string | null;
  status: string;
  duration_seconds: number | null;
};

export type RenderJob = {
  id: string;
  clip_id: string;
  user_id: string;
  status: string;
};

export async function claimNextProject(): Promise<Project | null> {
  if (!isSupabaseConfigured) return null;

  // Atomic-ish claim: pick oldest queued, mark downloading.
  const { data: queued, error: listError } = await supabase
    .from("projects")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  if (listError) {
    console.error("Failed to list queued projects", listError);
    return null;
  }
  if (!queued || queued.length === 0) return null;

  const id = queued[0].id;
  const { data, error } = await supabase
    .from("projects")
    .update({ status: "downloading", error_message: null })
    .eq("id", id)
    .eq("status", "queued")
    .select()
    .single();
  if (error || !data) {
    console.error("Failed to claim queued project", { id, error });
    return null;
  }
  console.log(`[${id}] claimed queued project`);
  return data as Project;
}

export async function claimNextRenderJob(): Promise<RenderJob | null> {
  if (!isSupabaseConfigured) return null;

  const { data: queued, error: listError } = await supabase
    .from("render_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  if (listError) {
    console.error("Failed to list queued render jobs", listError);
    return null;
  }
  if (!queued || queued.length === 0) return null;

  const id = queued[0].id;
  const { data, error } = await supabase
    .from("render_jobs")
    .update({ status: "running", progress: 5, error_message: null })
    .eq("id", id)
    .eq("status", "queued")
    .select("id, clip_id, user_id, status")
    .single();
  if (error || !data) {
    console.error("Failed to claim queued render job", { id, error });
    return null;
  }

  await supabase.from("clips").update({ status: "rendering" }).eq("id", data.clip_id);
  console.log(`[render job ${id}] claimed clip ${data.clip_id}`);
  return data as RenderJob;
}

export async function requeueStaleProjects(maxAgeMinutes = 30): Promise<number> {
  if (!isSupabaseConfigured) return 0;

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from("projects")
    .update({
      status: "queued",
      error_message: `Automatically requeued after ${maxAgeMinutes} minutes without completion`,
    })
    .in("status", ["downloading", "transcribing", "detecting_clips"])
    .lt("updated_at", cutoff)
    .select("id");

  if (error) {
    console.error("Failed to requeue stale projects", error);
    return 0;
  }

  const count = data?.length ?? 0;
  if (count > 0) console.warn(`Requeued ${count} stale project(s) older than ${maxAgeMinutes} minutes`);
  return count;
}

export async function setStatus(projectId: string, status: string, fields: Record<string, unknown> = {}) {
  const { error } = await supabase.from("projects").update({ status, ...fields }).eq("id", projectId);
  if (error) console.error(`[${projectId}] failed to set project status ${status}`, error);
}

export async function setError(projectId: string, msg: string) {
  await supabase
    .from("projects")
    .update({ status: "failed", error_message: msg.slice(0, 500) })
    .eq("id", projectId);
}
