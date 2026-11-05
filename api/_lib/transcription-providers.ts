export type TranscriptSegment = { start: number; end: number; text: string; speaker?: string };
export type TranscriptionResult = { text: string; segments: TranscriptSegment[]; provider: string; language?: string };
import { shouldTryNextTranscriptionProvider } from "./transcription-provider-policy.mjs";
type AudioInput = { audioBase64: string; mimeType: string; languageHint?: string; speakerLabels?: boolean };

function extensionFor(mime: string) {
  const value = mime.toLowerCase();
  if (value.includes("mpeg") || value.includes("mp3")) return "mp3";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4")) return "m4a";
  if (value.includes("aac")) return "aac";
  if (value.includes("webm")) return "webm";
  return "wav";
}

async function requestTranscription(endpoint: string, key: string, model: string, input: AudioInput, provider: string): Promise<TranscriptionResult> {
  const bytes = Buffer.from(input.audioBase64, "base64");
  const audioBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(audioBuffer).set(bytes);
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: input.mimeType }), "audio-chunk." + extensionFor(input.mimeType));
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("temperature", "0");
  if (input.languageHint) {
    const language = input.languageHint.trim();
    if (/^[a-z]{2}$/i.test(language)) form.append("language", language.toLowerCase());
    form.append("prompt", "Transcribe accurately. Preserve the words and language actually spoken. Do not translate, summarize, or invent unclear words. Language context: " + language.slice(0, 120));
  }
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: AbortSignal.timeout(12000) });
  const payload = await response.json().catch(() => ({})) as { text?: string; language?: string; segments?: Array<{ start?: number; end?: number; text?: string }>; error?: { message?: string } | string };
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw Object.assign(new Error(detail || provider + " returned HTTP " + response.status), { status: response.status });
  }
  if (!payload.text?.trim()) throw new Error(provider + " returned an empty transcript.");
  return {
    text: payload.text.trim(),
    language: payload.language,
    segments: Array.isArray(payload.segments) ? payload.segments.filter((s): s is { start: number; end: number; text: string } => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [],
    provider,
  };
}

/**
 * The synchronous Vercel route has a 60-second ceiling. Keep its AssemblyAI
 * attempt deliberately short; the separately hosted Worker owns the longer
 * asynchronous-style wait and provider retries for difficult/long sections.
 */
async function requestAssemblyAi(input: AudioInput, key: string): Promise<TranscriptionResult> {
  const bytes = Buffer.from(input.audioBase64, "base64");
  const upload = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(8000),
  });
  const uploadPayload = await upload.json().catch(() => ({})) as { upload_url?: string; error?: string };
  if (!upload.ok || !uploadPayload.upload_url) throw new Error(uploadPayload.error || "AssemblyAI audio upload failed (HTTP " + upload.status + ").");

  const submitted = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: uploadPayload.upload_url,
      speech_models: ["universal-3-5-pro", "universal-2"],
      language_detection: true,
      speaker_labels: input.speakerLabels !== false,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const submittedPayload = await submitted.json().catch(() => ({})) as { id?: string; error?: string };
  if (!submitted.ok || !submittedPayload.id) throw new Error(submittedPayload.error || "AssemblyAI could not start transcription (HTTP " + submitted.status + ").");

  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const polled = await fetch("https://api.assemblyai.com/v2/transcript/" + encodeURIComponent(submittedPayload.id), {
      headers: { authorization: key },
      signal: AbortSignal.timeout(5000),
    });
    const result = await polled.json().catch(() => ({})) as {
      status?: string; text?: string; language_code?: string; error?: string;
      utterances?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
    };
    if (!polled.ok) throw new Error(result.error || "AssemblyAI polling failed (HTTP " + polled.status + ").");
    if (result.status === "error") throw new Error(result.error || "AssemblyAI could not transcribe this audio section.");
    if (result.status === "completed") {
      const segments = Array.isArray(result.utterances) ? result.utterances
        .filter(item => typeof item.start === "number" && typeof item.end === "number" && typeof item.text === "string")
        .map(item => ({
          start: (item.start as number) / 1000,
          end: (item.end as number) / 1000,
          text: (item.text as string).trim(),
          speaker: typeof item.speaker === "string" && item.speaker ? "Speaker " + item.speaker : undefined,
        })).filter(item => item.text.length > 0) : [];
      const text = (result.text || segments.map(item => item.text).join(" ")).trim();
      if (!text) throw new Error("AssemblyAI returned an empty transcript.");
      return { text, segments, language: result.language_code, provider: "assemblyai" };
    }
  }
  throw new Error("AssemblyAI is still processing this section; handing off to the longer-running backup service.");
}

export async function transcribeWithFallback(input: AudioInput): Promise<TranscriptionResult> {
  const failures: string[] = [];
  if (process.env.ASSEMBLYAI_API_KEY) {
    try { return await requestAssemblyAi(input, process.env.ASSEMBLYAI_API_KEY); }
    catch (error) { failures.push("assemblyai: " + (error instanceof Error ? error.message : "request failed")); }
  }
  const providers = [
    { name: "groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo" },
    { name: "openai", key: process.env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1" },
  ].filter(provider => Boolean(provider.key));
  if (!providers.length) {
    const detail = failures.length ? " " + failures.join(" | ") : "";
    throw Object.assign(new Error("No transcription provider is configured. Add ASSEMBLYAI_API_KEY, GROQ_API_KEY or OPENAI_API_KEY to the backend environment." + detail), { status: 503, code: "NO_PROVIDER" });
  }
  for (const provider of providers) {
    try { return await requestTranscription(provider.url, provider.key!, provider.model, input, provider.name); }
    catch (error) {
      const status = (error as { status?: number }).status;
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "request failed"));
      if (!shouldTryNextTranscriptionProvider(status)) break;
    }
  }
  throw Object.assign(new Error("Primary transcription window ended or all primary providers failed. " + failures.join(" | ").slice(0, 500)), { status: 503, code: "PRIMARY_WINDOW_EXHAUSTED" });
}
