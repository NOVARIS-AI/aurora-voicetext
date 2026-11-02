export interface Env {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  OPENSUBTITLES_API_KEY?: string;
  OPENSUBTITLES_USER_AGENT?: string;
  BACKUP_API_TOKEN: string;
  GROQ_TRANSCRIPTION_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
  OPENAI_TTS_MODEL?: string;
  ELEVENLABS_TTS_MODEL?: string;
  OPENAI_TRANSLATION_MODEL?: string;
  GROQ_TRANSLATION_MODEL?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
}

type AudioBody = { audioBase64?: string; mimeType?: string; languageHint?: string; chunkNumber?: number; totalChunks?: number };
type TextBody = { text?: string; targetLanguage?: string; sourceLanguage?: string };
type VoiceBody = { text?: string; voice?: string; style?: string; emotion?: string; rate?: number; pitch?: number };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const authorized = (request: Request, env: Env) => Boolean(env.BACKUP_API_TOKEN && request.headers.get("authorization") === "Bearer " + env.BACKUP_API_TOKEN);
const rate = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.min(2, Math.max(.5, n)) : 1; };

async function callTranscription(endpoint: string, key: string, model: string, bytes: Uint8Array, mime: string, hint?: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), "audio-chunk." + (mime.includes("mpeg") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "wav"));
  form.append("model", model); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); form.append("temperature", "0");
  if (hint) form.append("prompt", "Transcribe accurately. Preserve the spoken language. " + hint.slice(0, 120));
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer " + key }, body: form, signal: AbortSignal.timeout(110000) });
  const payload = await response.json().catch(() => ({})) as { text?: string; segments?: Array<{start?:number;end?:number;text?:string}>; error?: {message?:string}|string };
  if (!response.ok) { const message = typeof payload.error === "string" ? payload.error : payload.error?.message; throw Object.assign(new Error(message || "Provider HTTP " + response.status), { status: response.status }); }
  if (!payload.text?.trim()) throw new Error("Provider returned empty text.");
  return { text: payload.text.trim(), segments: Array.isArray(payload.segments) ? payload.segments.filter(s => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [] };
}

async function transcribe(body: AudioBody, env: Env) {
  if (typeof body.audioBase64 !== "string" || !body.audioBase64.length || body.audioBase64.length > 1800000) return json({ error: "Invalid or oversized audio payload." }, 400);
  const mime = (body.mimeType || "audio/wav").toLowerCase();
  if (!["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"].includes(mime)) return json({ error: "Unsupported audio format." }, 400);
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(body.audioBase64), c => c.charCodeAt(0)); } catch { return json({ error: "Invalid base64 audio." }, 400); }
  const providers = [
    { key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo", name: "groq" },
    { key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1", name: "openai" },
  ].filter(p => p.key);
  if (!providers.length) return json({ error: "Backup transcription provider is not configured." }, 503);
  const failures: string[] = [];
  for (const provider of providers) {
    try { return json({ ...(await callTranscription(provider.url, provider.key!, provider.model, bytes, mime, body.languageHint)), provider: provider.name, chunkNumber: body.chunkNumber || 1, totalChunks: body.totalChunks || 1 }); }
    catch (error) {
      const status = (error as {status?:number}).status;
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed"));
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
    }
  }
  return json({ error: "Backup transcription providers failed: " + failures.join(" | ").slice(0, 400) }, 502);
}

async function synthesize(body: VoiceBody, env: Env) {
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 24000) return json({ error: "Text is required and must be at most 24,000 characters." }, 400);
  const failures: string[] = [];
  if (env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: body.voice || "alloy", input: body.text, response_format: "mp3", speed: rate(body.rate), instructions: [body.style, body.emotion].filter(Boolean).join(". ") || "Speak naturally and clearly." }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("OpenAI TTS HTTP " + response.status);
      return new Response(await response.arrayBuffer(), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "X-AURORA-Provider": "backup-openai-tts" } });
    } catch (error) { failures.push(error instanceof Error ? error.message : "OpenAI TTS failed"); }
  }
  if (env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = body.voice && /^[A-Za-z0-9_-]{5,80}$/.test(body.voice) ? body.voice : (env.ELEVENLABS_DEFAULT_VOICE_ID || "EXAVITQu4vr4xnSDxMaL");
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
        method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: body.text, model_id: env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2", voice_settings: { stability: .5, similarity_boost: .75, style: .25, use_speaker_boost: true, speed: rate(body.rate) } }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("ElevenLabs TTS HTTP " + response.status);
      return new Response(await response.arrayBuffer(), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "X-AURORA-Provider": "backup-elevenlabs" } });
    } catch (error) { failures.push(error instanceof Error ? error.message : "ElevenLabs TTS failed"); }
  }
  return json({ error: failures.join(" | ") || "No backup speech provider is configured." }, 503);
}

async function translate(body: TextBody, env: Env) {
  if (typeof body.text !== "string" || !body.text.trim() || typeof body.targetLanguage !== "string" || !body.targetLanguage.trim() || body.text.length > 24000) return json({ error: "Text and targetLanguage are required (maximum 24,000 characters)." }, 400);
  const providers = [
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini" },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile" },
  ].filter(p => p.key);
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: provider.model, temperature: .1, messages: [{ role: "system", content: "Translate faithfully. Preserve names, numbers, speaker labels, subtitle line breaks and timestamps. Do not add explanations." }, { role: "user", content: "Source: " + (body.sourceLanguage || "auto-detect") + "\nTarget: " + body.targetLanguage + "\n\n" + body.text }] }), signal: AbortSignal.timeout(90000) });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{message?:{content?:string}}>; error?:{message?:string} };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!response.ok || !text) throw new Error(payload.error?.message || provider.name + " translation failed.");
      return json({ text, provider: "backup-" + provider.name });
    } catch { /* Try the next configured provider. */ }
  }
  return json({ error: "No backup translation provider is available." }, 503);
}

async function subtitles(body: {query?:string;languages?:string;type?:string}, env: Env) {
  if (typeof body.query !== "string" || body.query.trim().length < 2 || body.query.length > 180) return json({ error: "Enter a video title." }, 400);
  if (!env.OPENSUBTITLES_API_KEY) return json({ error: "Backup subtitle search is not configured." }, 503);
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", body.query.trim()); url.searchParams.set("languages", (body.languages || "en").slice(0,80)); url.searchParams.set("order_by","download_count"); url.searchParams.set("order_direction","desc");
  if (body.type === "movie" || body.type === "episode") url.searchParams.set("type", body.type);
  const response = await fetch(url, { headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0" }, signal: AbortSignal.timeout(25000) });
  const payload = await response.json().catch(() => ({})) as { data?: Array<{id?:string;attributes?:{language?:string;release?:string;download_count?:number;upload_date?:string;hearing_impaired?:boolean;feature_details?:{title?:string;movie_name?:string;year?:number};files?:Array<{file_id?:number;file_name?:string}>}}> };
  if (!response.ok) return json({ error: "Subtitle provider returned HTTP " + response.status }, 502);
  const results = (payload.data || []).slice(0,30).map(item => { const a=item.attributes||{}, f=a.files?.[0]||{}; return { id:item.id||String(f.file_id||""), fileId:f.file_id||null, fileName:f.file_name||"Subtitle file", language:a.language||"", release:a.release||"", title:a.feature_details?.movie_name||a.feature_details?.title||body.query, year:a.feature_details?.year||null, hearingImpaired:Boolean(a.hearing_impaired), downloads:a.download_count||0, uploadedAt:a.upload_date||null, downloadRequiresProviderAuthorization:true }; });
  return json({ results, provider: "backup-opensubtitles" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "aurora-voicetext-backup", status: "ok", capabilities: { transcription: Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY), aiSpeech: Boolean(env.OPENAI_API_KEY || env.ELEVENLABS_API_KEY), translation: Boolean(env.OPENAI_API_KEY || env.GROQ_API_KEY), subtitleSearch: Boolean(env.OPENSUBTITLES_API_KEY) } });
    if (!["/api/transcribe","/api/tts","/api/translate","/api/subtitles"].includes(url.pathname)) return json({ error: "Not found." }, 404);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Invalid JSON body." }, 400);
    if (url.pathname === "/api/transcribe") return transcribe(body as AudioBody, env);
    if (url.pathname === "/api/tts") return synthesize(body as VoiceBody, env);
    if (url.pathname === "/api/translate") return translate(body as TextBody, env);
    return subtitles(body as {query?:string;languages?:string;type?:string}, env);
  }
};
