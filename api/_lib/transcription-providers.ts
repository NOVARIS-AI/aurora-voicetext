export type TranscriptSegment = { start: number; end: number; text: string };
export type TranscriptionResult = { text: string; segments: TranscriptSegment[]; provider: string };
type AudioInput = { audioBase64: string; mimeType: string; languageHint?: string };

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
  if (input.languageHint) form.append("prompt", "Transcribe accurately. Preserve the words and language actually spoken. Do not translate, summarize, or invent unclear words. Language context: " + input.languageHint.slice(0, 120));
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: AbortSignal.timeout(110000) });
  const payload = await response.json().catch(() => ({})) as { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }>; error?: { message?: string } | string };
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw Object.assign(new Error(detail || provider + " returned HTTP " + response.status), { status: response.status });
  }
  if (!payload.text?.trim()) throw new Error(provider + " returned an empty transcript.");
  return {
    text: payload.text.trim(),
    segments: Array.isArray(payload.segments) ? payload.segments.filter((s): s is { start: number; end: number; text: string } => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [],
    provider,
  };
}

export async function transcribeWithFallback(input: AudioInput): Promise<TranscriptionResult> {
  const providers = [
    { name: "groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: process.env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo" },
    { name: "openai", key: process.env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: process.env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1" },
  ].filter(provider => Boolean(provider.key));
  if (!providers.length) throw Object.assign(new Error("No transcription provider is configured. Add GROQ_API_KEY or OPENAI_API_KEY to the backend environment."), { status: 503, code: "NO_PROVIDER" });
  const failures: string[] = [];
  for (const provider of providers) {
    try { return await requestTranscription(provider.url, provider.key!, provider.model, input, provider.name); }
    catch (error) {
      const status = (error as { status?: number }).status;
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "request failed"));
      // Client errors usually indicate invalid input; don't spend another provider call on the same payload.
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
    }
  }
  throw Object.assign(new Error("All configured transcription providers failed. " + failures.join(" | ").slice(0, 500)), { status: 502, code: "ALL_PROVIDERS_FAILED" });
}
