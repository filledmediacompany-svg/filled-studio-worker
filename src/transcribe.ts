import { promises as fs } from "fs";
import FormData from "form-data";
import fetch from "node-fetch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ASSEMBLYAI_BASE_URL = process.env.ASSEMBLYAI_BASE_URL || "https://api.assemblyai.com";

export type Transcript = {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Array<{ word: string; start: number; end: number }>;
};

export async function transcribe(audioPath: string): Promise<Transcript> {
  if (ASSEMBLYAI_API_KEY) return transcribeWithAssemblyAI(audioPath);
  return transcribeWithOpenAI(audioPath);
}

async function transcribeWithAssemblyAI(audioPath: string): Promise<Transcript> {
  if (!ASSEMBLYAI_API_KEY) throw new Error("ASSEMBLYAI_API_KEY missing");
  const headers = { authorization: ASSEMBLYAI_API_KEY };
  const audio = await fs.readFile(audioPath);

  const uploadRes = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/upload`, {
    method: "POST",
    headers,
    body: audio,
  });
  if (!uploadRes.ok) throw new Error(`AssemblyAI upload ${uploadRes.status}: ${await uploadRes.text()}`);
  const uploadJson: any = await uploadRes.json();
  if (!uploadJson.upload_url) throw new Error("AssemblyAI upload returned no upload_url");

  const transcriptRes = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadJson.upload_url,
      speech_models: ["universal-3-pro", "universal-2"],
      language_detection: true,
    }),
  });
  if (!transcriptRes.ok) throw new Error(`AssemblyAI transcript ${transcriptRes.status}: ${await transcriptRes.text()}`);
  const submitted: any = await transcriptRes.json();
  if (!submitted.id) throw new Error("AssemblyAI transcript returned no id");

  const transcript = await pollAssemblyAITranscript(submitted.id, headers);
  const words = (transcript.words ?? []).map((word: any) => ({
    word: word.text ?? word.word ?? "",
    start: toSeconds(word.start),
    end: toSeconds(word.end),
  })).filter((word: { word: string }) => word.word);

  return {
    text: transcript.text ?? "",
    segments: toAssemblyAISegments(transcript, words),
    words,
  };
}

async function pollAssemblyAITranscript(id: string, headers: { authorization: string }): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < 10 * 60 * 1000) {
    const res = await fetch(`${ASSEMBLYAI_BASE_URL}/v2/transcript/${id}`, { headers });
    if (!res.ok) throw new Error(`AssemblyAI poll ${res.status}: ${await res.text()}`);
    const transcript: any = await res.json();
    if (transcript.status === "completed") return transcript;
    if (transcript.status === "error") throw new Error(`AssemblyAI transcription failed: ${transcript.error ?? "unknown error"}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`AssemblyAI transcription timed out: ${id}`);
}

function toAssemblyAISegments(
  transcript: any,
  words: Array<{ word: string; start: number; end: number }>,
): Array<{ start: number; end: number; text: string }> {
  if (Array.isArray(transcript.utterances) && transcript.utterances.length > 0) {
    return transcript.utterances.map((utterance: any) => ({
      start: toSeconds(utterance.start),
      end: toSeconds(utterance.end),
      text: utterance.text ?? "",
    }));
  }

  if (words.length === 0) {
    return transcript.text ? [{ start: 0, end: 0, text: transcript.text }] : [];
  }

  const segments: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < words.length; i += 40) {
    const slice = words.slice(i, i + 40);
    segments.push({
      start: slice[0].start,
      end: slice[slice.length - 1].end,
      text: slice.map((word) => word.word).join(" "),
    });
  }
  return segments;
}

function toSeconds(value: unknown): number {
  const numeric = Number(value ?? 0);
  return numeric > 1000 ? numeric / 1000 : numeric;
}

/** OpenAI Whisper API. Returns verbose_json with segments. */
async function transcribeWithOpenAI(audioPath: string): Promise<Transcript> {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
  const buf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append("file", buf, { filename: "audio.mp3", contentType: "audio/mpeg" });
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

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
    words: (json.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end })),
  };
}
