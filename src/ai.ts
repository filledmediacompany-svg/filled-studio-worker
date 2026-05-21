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

  if (!LOVABLE_API_KEY && !OPENAI_API_KEY) return detectClipsLocally(transcriptText, duration);

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
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      console.warn(`OpenAI clip detection quota hit; using local fallback: ${body.slice(0, 300)}`);
      return detectClipsLocally(user, duration);
    }
    throw new Error(`OpenAI clip detection ${res.status}: ${body}`);
  }
  const json: any = await res.json();
  const parsed = parseJsonContent(json.choices?.[0]?.message?.content);
  const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
  return clips.map((clip: any) => normalizeClip(clip, duration));
}

function detectClipsLocally(transcriptText: string, duration: number): DetectedClip[] {
  const text = transcriptText.replace(/\s+/g, " ").trim();
  if (!text) {
    return [{
      title: "Opening moment",
      hook: "Start here.",
      start_seconds: 0,
      end_seconds: Math.min(duration || 30, 30),
      virality_score: 60,
      hook_score: 60,
      retention_score: 60,
      transcript_excerpt: "",
    }];
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const totalWords = text.split(/\s+/).filter(Boolean).length || 1;
  const secondsPerWord = Math.max(duration / totalWords, 0.25);

  const windows: Array<{ text: string; start: number; end: number; score: number }> = [];
  let wordCursor = 0;
  for (let i = 0; i < sentences.length; i += 3) {
    const group = sentences.slice(i, i + 4);
    const groupText = group.join(" ");
    const words = groupText.split(/\s+/).filter(Boolean).length;
    const start = Math.min(duration, wordCursor * secondsPerWord);
    const end = Math.min(duration, Math.max(start + 8, (wordCursor + words) * secondsPerWord));
    wordCursor += words;
    windows.push({ text: groupText, start, end, score: scoreLocalClip(groupText) });
  }

  const ranked = windows
    .filter((clip) => clip.end - clip.start >= 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const fallback = ranked.length > 0 ? ranked : [{ text, start: 0, end: Math.min(duration, 60), score: 62 }];
  return fallback.map((clip, index) => {
    const excerpt = clip.text.slice(0, 280);
    return {
      title: makeLocalTitle(excerpt, index),
      hook: makeLocalHook(excerpt),
      start_seconds: Math.max(0, Math.round(clip.start)),
      end_seconds: Math.min(duration, Math.max(Math.round(clip.end), Math.round(clip.start) + 5)),
      virality_score: clip.score,
      hook_score: Math.min(100, clip.score + 3),
      retention_score: clip.score,
      transcript_excerpt: excerpt,
    };
  });
}

function scoreLocalClip(text: string): number {
  const lower = text.toLowerCase();
  const hooks = ["but", "because", "never", "always", "why", "how", "secret", "mistake", "truth", "actually", "remember", "stop", "start"];
  const bonus = hooks.reduce((sum, hook) => sum + (lower.includes(hook) ? 4 : 0), 0);
  const lengthBonus = Math.min(18, Math.max(0, text.split(/\s+/).length - 20) / 2);
  return Math.max(55, Math.min(88, Math.round(58 + bonus + lengthBonus)));
}

function makeLocalTitle(text: string, index: number): string {
  const clean = text.replace(/[^\w\s'"-]/g, "").split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
  return clean || `Clip candidate ${index + 1}`;
}

function makeLocalHook(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s+/)[0]?.trim();
  return (sentence || text).slice(0, 180);
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
