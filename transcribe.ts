import { promises as fs } from "fs";
import FormData from "form-data";
import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export type Transcript = {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
};

/** OpenAI Whisper API. Returns verbose_json with segments. */
export async function transcribe(audioPath: string): Promise<Transcript> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const buf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", buf, { filename: "audio.mp3", contentType: "audio/mpeg" });
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return {
    text: json.text,
    segments: (json.segments ?? []).map((s: any) => ({ start: s.start, end: s.end, text: s.text })),
  };
}
