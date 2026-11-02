export interface Env {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BACKUP_API_TOKEN: string;
  GROQ_TRANSCRIPTION_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
}

type Body = { audioBase64?: string; mimeType?: string; languageHint?: string; chunkNumber?: number; totalChunks?: number };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function callProvider(endpoint: string, key: string, model: string, bytes: Uint8Array, mime: string, languageHint?: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), "audio-chunk." + (mime.includes("mpeg") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : "wav"));
  form.append("model", model); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); form.append("temperature", "0");
  if (languageHint) form.append("prompt", "Transcribe accurately. Preserve the spoken language. " + languageHint.slice(0, 120));
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: AbortSignal.timeout(110000) });
  const payload = await response.json().catch(() => ({})) as { text?: string; segments?: Array<{start?:number;end?:number;text?:string}>; error?: {message?:string}|string };
  if (!response.ok) { const message = typeof payload.error === "string" ? payload.error : payload.error?.message; throw Object.assign(new Error(message || "Provider HTTP " + response.status), { status: response.status }); }
  if (!payload.text?.trim()) throw new Error("Provider returned empty text.");
  return { text: payload.text.trim(), segments: Array.isArray(payload.segments) ? payload.segments.filter(s => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [] };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "aurora-voicetext-backup", status: "ok", transcription: Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY) });
    if (url.pathname !== "/api/transcribe") return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (!env.BACKUP_API_TOKEN || request.headers.get("authorization") !== "Bearer " + env.BACKUP_API_TOKEN) return json({ error: "Unauthorized." }, 401);
    const body = await request.json().catch(() => null) as Body | null;
    if (!body || typeof body.audioBase64 !== "string" || !body.audioBase64.length || body.audioBase64.length > 1800000) return json({ error: "Invalid or oversized audio payload." }, 400);
    const mime = body.mimeType || "audio/wav";
    if (!["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"].includes(mime.toLowerCase())) return json({ error: "Unsupported audio format." }, 400);
    const bytes = Uint8Array.from(atob(body.audioBase64), c => c.charCodeAt(0));
    const providers = [
      { key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo", name: "groq" },
      { key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1", name: "openai" },
    ].filter(p => p.key);
    if (!providers.length) return json({ error: "Backup transcription provider is not configured." }, 503);
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        const result = await callProvider(provider.url, provider.key!, provider.model, bytes, mime, body.languageHint);
        return json({ ...result, provider: provider.name, chunkNumber: body.chunkNumber || 1, totalChunks: body.totalChunks || 1 });
      } catch (error) {
        const status = (error as {status?:number}).status;
        failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed"));
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      }
    }
    return json({ error: "Backup providers failed: " + failures.join(" | ").slice(0, 400) }, 502);
  }
};
