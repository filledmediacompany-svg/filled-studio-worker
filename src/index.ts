import { createServer } from "http";
import { claimNextProject, isSupabaseConfigured, missingSupabaseEnv, requeueStaleProjects } from "./supabase.js";
import { processProject } from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3000);
const STALE_PROJECT_MINUTES = Number(process.env.STALE_PROJECT_MINUTES ?? 30);

type WorkerState = {
  configured: boolean;
  currentProjectId: string | null;
  lastError: string | null;
  lastPollAt: string | null;
  lastProjectClaimedAt: string | null;
  lastStaleRequeueAt: string | null;
  missingEnv: string[];
  startedAt: string;
};

const state: WorkerState = {
  configured: isSupabaseConfigured,
  currentProjectId: null,
  lastError: null,
  lastPollAt: null,
  lastProjectClaimedAt: null,
  lastStaleRequeueAt: null,
  missingEnv: missingSupabaseEnv,
  startedAt: new Date().toISOString(),
};

function startHealthServer() {
  const server = createServer((req, res) => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...state }));
  });

  server.listen(PORT, () => {
    console.log(`Health endpoint listening on :${PORT}`);
  });
}

async function loop() {
  console.log("Filled Studio worker started. Polling every", POLL_INTERVAL_MS, "ms");
  let processing = false;
  while (true) {
    if (!isSupabaseConfigured) {
      state.lastError = `Worker paused: missing ${missingSupabaseEnv.join(", ")}`;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    if (!processing) {
      processing = true;
      try {
        state.lastPollAt = new Date().toISOString();
        const requeued = await requeueStaleProjects(STALE_PROJECT_MINUTES);
        if (requeued > 0) state.lastStaleRequeueAt = new Date().toISOString();

        const project = await claimNextProject();
        if (project) {
          state.currentProjectId = project.id;
          state.lastProjectClaimedAt = new Date().toISOString();
          await processProject(project);
          state.currentProjectId = null;
        }
      } catch (e) {
        state.lastError = e instanceof Error ? e.message : String(e);
        console.error("loop error", e);
      } finally {
        if (state.currentProjectId) state.currentProjectId = null;
        processing = false;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

startHealthServer();

loop().catch((e) => {
  state.lastError = e instanceof Error ? e.message : String(e);
  console.error("Fatal worker error", e);
  process.exit(1);
});
