import { claimNextProject } from "./supabase.js";
import { processProject } from "./pipeline.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

async function loop() {
  console.log("Filled Studio worker started. Polling every", POLL_INTERVAL_MS, "ms");
  let processing = false;
  while (true) {
    if (!processing) {
      processing = true;
      try {
        const project = await claimNextProject();
        if (project) {
          await processProject(project);
        }
      } catch (e) {
        console.error("loop error", e);
      } finally {
        processing = false;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

loop().catch((e) => {
  console.error("Fatal worker error", e);
  process.exit(1);
});
