import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase credentials!");
  console.error("SUPABASE_URL:", SUPABASE_URL ? "✓ Set" : "✗ Missing");
  console.error("SUPABASE_SERVICE_ROLE_KEY:", SUPABASE_SERVICE_ROLE_KEY ? "✓ Set" : "✗ Missing");
  console.error("All environment variables:", Object.keys(process.env).filter(k => k.includes("SUPABASE") || k.includes("DATABASE")).sort());
  process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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

export async function claimNextProject(): Promise<Project | null> {
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

export async function requeueStaleProjects(maxAgeMinutes = 30): Promise<number> {
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
