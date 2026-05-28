import { createServer } from "http";
import { claimNextProject, isSupabaseConfigured, missingSupabaseEnv, requeueStaleProjects } from "./supabase.js";
import { processProject } from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3000);
const STALE_PROJECT_MINUTES = Number(process.env.STALE_PROJECT_MINUTES ?? 30);
const STUDIO_APP_URL = process.env.STUDIO_APP_URL ?? "https://filled-studio-app.onrender.com";

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
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Filled Studio Worker</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080808; color: #f8f4e8; font-family: Inter, system-ui, sans-serif; }
      main { width: min(560px, calc(100vw - 32px)); border: 1px solid #2a261d; border-radius: 14px; padding: 28px; background: #111; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
      .eyebrow { color: #f2c84b; font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .18em; text-transform: uppercase; }
      h1 { margin: 10px 0 8px; font-size: 32px; line-height: 1; }
      p { color: #b7b0a1; line-height: 1.55; }
      a { display: inline-flex; margin-top: 18px; border-radius: 999px; background: #f2c84b; color: #151109; padding: 11px 16px; text-decoration: none; font-weight: 700; }
      code { color: #f2c84b; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">Filled Studio Worker</div>
      <h1>This is the background worker.</h1>
      <p>This service processes queued uploads and renders clips. The editor lives in the Filled Studio app, not on this worker URL.</p>
      <p>Worker health is available at <code>/health</code>.</p>
      <a href="${STUDIO_APP_URL}">Open Filled Studio</a>
    </main>
  </body>
</html>`);
      return;
    }

    if (req.url !== "/health") {
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
