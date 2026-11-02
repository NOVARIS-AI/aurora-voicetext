export interface Env {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BACKUP_API_TOKEN?: string;
  BACKUP_PUBLIC_FALLBACK?: string;
  GROQ_TRANSCRIPTION_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
}
type Body = { audioBase64?: string; mimeType?: string; languageHint?: string; chunkNumber?: number; totalChunks?: number };
const allowedOrigins = new Set(["https://aurora-voicetext-qk8s.vercel.app","https://aurora-voicetext.vercel.app","capacitor://localhost","https://localhost","http://localhost"]);
async function callProvider(endpoint: string, key: string, model: string, bytes: Uint8Array, mime: string, languageHint?: string) {
  const form = new FormData();
  const audioBuffer = new Uint8Array(bytes.byteLength); audioBuffer.set(bytes);
  form.append("file", new Blob([audioBuffer.buffer], { type: mime }), "audio-chunk." + (mime.includes("mpeg") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : "wav"));
  form.append("model", model); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); form.append("temperature", "0");
  if (languageHint) form.append("prompt", "Transcribe accurately. Preserve the spoken language. " + languageHint.slice(0, 120));
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: AbortSignal.timeout(110000) });
  const payload = await response.json().catch(() => ({})) as { text?: string; segments?: Array<{start?:number;end?:number;text?:string}>; error?: {message?:string}|string };
  if (!response.ok) { const message = typeof payload.error === "string" ? payload.error : payload.error?.message; throw Object.assign(new Error(message || "Provider HTTP " + response.status), { status: response.status }); }
  if (!payload.text?.trim()) throw new Error("Provider returned empty text.");
  return { text: payload.text.trim(), segments: Array.isArray(payload.segments) ? payload.segments.filter(s => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [] };
}
async function downloadSubtitle(body: { fileId?: number }, env: Env) {
  if (!Number.isInteger(body.fileId) || !body.fileId || body.fileId < 1) return json({ error: "A valid subtitle file ID is required." }, 400);
  if (!env.OPENSUBTITLES_API_KEY || !env.OPENSUBTITLES_TOKEN) return json({ error: "Subtitle download requires OPENSUBTITLES_API_KEY and OPENSUBTITLES_TOKEN." }, 503);
  const response = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0", Authorization: "Bearer " + env.OPENSUBTITLES_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: body.fileId }),
    signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json().catch(() => ({})) as { link?: string; file_name?: string; message?: string };
  if (!response.ok || !payload.link) return json({ error: payload.message || "Subtitle provider did not authorize this download." }, response.status || 502);
  const fileResponse = await fetch(payload.link, { signal: AbortSignal.timeout(30000) });
  if (!fileResponse.ok) return json({ error: "Could not retrieve the authorized subtitle file." }, 502);
  return new Response(await fileResponse.arrayBuffer(), { headers: { "content-type": fileResponse.headers.get("content-type") || "application/octet-stream", "content-disposition": 'attachment; filename="' + (payload.file_name || "subtitle.srt").replace(/[^A-Za-z0-9._-]/g, "_") + '"', "cache-control": "no-store", "X-AURORA-Provider": "backup-opensubtitles" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const originAllowed = allowedOrigins.has(origin);
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    if (originAllowed) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "aurora-voicetext-backup", status: "ok", transcription: Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY) });
    if (url.pathname !== "/api/transcribe") return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    const bearer = Boolean(env.BACKUP_API_TOKEN) && request.headers.get("authorization") === "Bearer " + env.BACKUP_API_TOKEN;
    const publicAllowed = env.BACKUP_PUBLIC_FALLBACK === "true" && originAllowed;
    if (!bearer && !publicAllowed) return json({ error: "Unauthorized or origin not allowed." }, 401);
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
