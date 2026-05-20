import fetch from "node-fetch";

const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLIP_DETECTION_MODEL = process.env.CLIP_DETECTION_MODEL ?? "gpt-4o-mini";

export type DetectedClip = {
  title: string;
  hook: string;
  start_seconds: number;
  end_seconds: number;
  virality_score: number;
  hook_score?: number;
  retention_score?: number;
  transcript_excerpt?: string;
};

export async function detectClips(transcriptText: string, duration: number): Promise<DetectedClip[]> {
  const system =
    "You are an expert short-form video editor. Given a podcast transcript, identify the 5 most viral 30-90 second moments. Score by hook strength, retention, emotional payoff, and shareability. Return JSON only.";
  const user = `Transcript (duration ${duration}s):\n${transcriptText}\n\nReturn JSON: { "clips": [{ "title": string, "hook": string, "start_seconds": number, "end_seconds": number, "virality_score": number, "hook_score": number, "retention_score": number, "transcript_excerpt": string }] }`;

  if (!LOVABLE_API_KEY) return detectClipsWithOpenAI(system, user, duration);

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`AI gateway ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const parsed = parseJsonContent(json.choices?.[0]?.message?.content);
  const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
  return clips.map((clip: any) => normalizeClip(clip, duration));
}

async function detectClipsWithOpenAI(system: string, user: string, duration: number): Promise<DetectedClip[]> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLIP_DETECTION_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI clip detection ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const parsed = parseJsonContent(json.choices?.[0]?.message?.content);
  const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
  return clips.map((clip: any) => normalizeClip(clip, duration));
}

function normalizeClip(clip: any, duration: number): DetectedClip {
  const start = clampNumber(clip.start_seconds, 0, Math.max(0, duration - 5));
  const minEnd = Math.min(duration, start + 1);
  const end = clampNumber(clip.end_seconds, minEnd, duration);
  const virality = clampNumber(clip.virality_score, 0, 100);
  return {
    title: String(clip.title ?? "Untitled clip").slice(0, 140),
    hook: String(clip.hook ?? clip.title ?? "Strong moment").slice(0, 500),
    start_seconds: start,
    end_seconds: end,
    virality_score: virality,
    hook_score: clampNumber(clip.hook_score ?? virality, 0, 100),
    retention_score: clampNumber(clip.retention_score ?? virality, 0, 100),
    transcript_excerpt: String(clip.transcript_excerpt ?? "").slice(0, 1000),
  };
}

function parseJsonContent(content: unknown): any {
  if (typeof content !== "string") return {};
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function clampNumber(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
