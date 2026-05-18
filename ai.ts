import fetch from "node-fetch";

const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;

export type DetectedClip = {
  title: string;
  hook: string;
  start_seconds: number;
  end_seconds: number;
  virality_score: number;
};

export async function detectClips(transcriptText: string, duration: number): Promise<DetectedClip[]> {
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");
  const system =
    "You are an expert short-form video editor. Given a podcast transcript, identify the 5 most viral 30-90 second moments. Score by hook strength, emotional payoff, and shareability. Return JSON only.";
  const user = `Transcript (duration ${duration}s):\n${transcriptText}\n\nReturn JSON: { "clips": [{ "title": string, "hook": string, "start_seconds": number, "end_seconds": number, "virality_score": number 0-100 }] }`;

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
  const parsed = JSON.parse(json.choices[0].message.content);
  return parsed.clips as DetectedClip[];
}
