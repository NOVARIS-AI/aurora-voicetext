export interface Env {
  GROQ_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_DEFAULT_VOICE_ID?: string;
  ELEVENLABS_VOICE_NOVA_ID?: string;
  ELEVENLABS_VOICE_SHIMMER_ID?: string;
  ELEVENLABS_VOICE_CORAL_ID?: string;
  ELEVENLABS_VOICE_SAGE_ID?: string;
  ELEVENLABS_VOICE_ONYX_ID?: string;
  ELEVENLABS_VOICE_ECHO_ID?: string;
  ELEVENLABS_VOICE_ASH_ID?: string;
  ELEVENLABS_VOICE_FABLE_ID?: string;
  ELEVENLABS_VOICE_ALLOY_ID?: string;
  OPENSUBTITLES_API_KEY?: string;
  OPENSUBTITLES_TOKEN?: string;
  OPENSUBTITLES_USER_AGENT?: string;
  BACKUP_API_TOKEN?: string;
  BACKUP_PUBLIC_FALLBACK?: string;
  GROQ_TRANSCRIPTION_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
  OPENAI_TTS_MODEL?: string;
  ELEVENLABS_TTS_MODEL?: string;
  OPENAI_TRANSLATION_MODEL?: string;
  GROQ_TRANSLATION_MODEL?: string;
}
type AudioBody = { audioBase64?: string; mimeType?: string; languageHint?: string; chunkNumber?: number; totalChunks?: number };
type VoiceBody = { text?: string; voice?: string; style?: string; rate?: number; pitch?: number; emotion?: string };
type TranslateBody = { text?: string; targetLanguage?: string; sourceLanguage?: string };
type SubtitleBody = { query?: string; languages?: string; type?: "movie" | "episode" };
const allowedOrigins = new Set(["https://aurora-voicetext-qk8s.vercel.app","https://aurora-voicetext.vercel.app","capacitor://localhost","https://localhost","http://localhost"]);
const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...Object.fromEntries(new Headers(headers || {}).entries()) } });
const safeRate = (value: unknown) => Number.isFinite(Number(value)) ? Math.min(2, Math.max(0.5, Number(value))) : 1;

async function transcribe(bytes: Uint8Array, mime: string, env: Env, languageHint?: string) {
  const providers = [
    { key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo", name: "groq" },
    { key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1", name: "openai" },
  ].filter(p => p.key);
  if (!providers.length) throw new Error("No backup transcription provider configured.");
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const form = new FormData();
      const audio = new Uint8Array(bytes.byteLength); audio.set(bytes);
      const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "wav";
      form.append("file", new Blob([audio.buffer], { type: mime }), "audio-chunk." + ext);
      form.append("model", provider.model); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); form.append("temperature", "0");
      if (languageHint) form.append("prompt", "Transcribe accurately. Preserve the spoken language. " + languageHint.slice(0, 120));
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key }, body: form, signal: AbortSignal.timeout(110000) });
      const payload = await response.json().catch(() => ({})) as { text?: string; segments?: Array<{start?:number;end?:number;text?:string}>; error?: {message?:string}|string };
      if (!response.ok || !payload.text?.trim()) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw Object.assign(new Error(message || provider.name + " transcription failed."), { status: response.status });
      }
      return { text: payload.text.trim(), segments: Array.isArray(payload.segments) ? payload.segments.filter(s => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [], provider: provider.name };
    } catch (error) {
      const status = (error as {status?:number}).status;
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed"));
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
    }
  }
  throw new Error("Backup transcription providers failed: " + failures.join(" | ").slice(0, 350));
}

async function synthesize(input: VoiceBody, env: Env): Promise<{ audio: ArrayBuffer; provider: string }> {
  const text = input.text!.trim();
  const failures: string[] = [];
  if (env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: input.voice || "alloy", input: text, response_format: "mp3", speed: safeRate(input.rate), instructions: [input.style, input.emotion, input.pitch ? "Pitch preference: " + input.pitch : ""].filter(Boolean).join(". ").slice(0, 800) || "Speak naturally and clearly." }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("OpenAI TTS HTTP " + response.status);
      return { audio: await response.arrayBuffer(), provider: "openai-tts" };
    } catch (error) { failures.push(error instanceof Error ? error.message : "OpenAI TTS failed"); }
  }
  if (env.ELEVENLABS_API_KEY) {
    try {
      const builtInVoiceNames = new Set(["nova","shimmer","coral","sage","onyx","echo","ash","fable","alloy"]);
      const voiceKey = ("ELEVENLABS_VOICE_" + (input.voice || "").toUpperCase() + "_ID") as keyof Env;
      const configuredVoiceId = env[voiceKey];
      const voice = (typeof configuredVoiceId === "string" && configuredVoiceId) || (input.voice && /^[A-Za-z0-9_-]{5,80}$/.test(input.voice) && !builtInVoiceNames.has(input.voice.toLowerCase()) ? input.voice : (env.ELEVENLABS_DEFAULT_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"));
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voice), {
        method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true, speed: safeRate(input.rate) } }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("ElevenLabs TTS HTTP " + response.status);
      return { audio: await response.arrayBuffer(), provider: "elevenlabs" };
    } catch (error) { failures.push(error instanceof Error ? error.message : "ElevenLabs TTS failed"); }
  }
  throw new Error(failures.join(" | ") || "No backup AI speech provider configured.");
}

async function translate(input: TranslateBody, env: Env) {
  const providers = [
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini" },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile" },
  ].filter(p => p.key);
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: provider.model, temperature: 0.1, messages: [{ role: "system", content: "Translate faithfully. Preserve meaning, names, numbers, speaker labels, subtitle line breaks and timestamps. Do not add explanations or invent missing content." }, { role: "user", content: "Source language: " + (input.sourceLanguage || "auto-detect") + "\nTarget language: " + input.targetLanguage + "\n\n" + input.text }] }), signal: AbortSignal.timeout(90000) });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{message?:{content?:string}}>; error?:{message?:string} };
      const result = payload.choices?.[0]?.message?.content?.trim();
      if (!response.ok || !result) throw new Error(payload.error?.message || provider.name + " translation failed.");
      return { text: result, provider: provider.name };
    } catch (error) { failures.push(error instanceof Error ? error.message : "translation failed"); }
  }
  throw new Error(failures.join(" | ") || "No backup translation provider configured.");
}

async function polishTranscript(text: string, env: Env): Promise<{ text: string; provider: string }> {
  const providers = [
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini" },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile" },
  ].filter(p => p.key);
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json" }, body: JSON.stringify({ model: provider.model, temperature: 0.1, messages: [
        { role: "system", content: "Clean this speech transcript for readability. Correct punctuation, capitalization and obvious transcription formatting issues. Preserve every factual detail, sentence, name, number, language and Nigerian Pidgin expression. Do not summarize, add facts, translate, or omit content. Return only the corrected transcript." },
        { role: "user", content: text },
      ] }), signal: AbortSignal.timeout(90000) });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{message?:{content?:string}}>; error?:{message?:string} };
      const result = payload.choices?.[0]?.message?.content?.trim();
      if (!response.ok || !result) throw new Error(payload.error?.message || provider.name + " transcript cleanup failed.");
      return { text: result, provider: provider.name };
    } catch (error) { failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed")); }
  }
  throw new Error(failures.join(" | ") || "No AI text provider configured.");
}

async function subtitleSearch(input: SubtitleBody, env: Env) {
  if (!env.OPENSUBTITLES_API_KEY) throw new Error("Subtitle search provider is not configured.");
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", input.query!); url.searchParams.set("languages", (input.languages || "en").slice(0, 80)); url.searchParams.set("order_by", "download_count"); url.searchParams.set("order_direction", "desc");
  if (input.type) url.searchParams.set("type", input.type);
  const response = await fetch(url, { headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0" }, signal: AbortSignal.timeout(25000) });
  const payload = await response.json().catch(() => ({})) as { data?: Array<{id?:string;attributes?:{language?:string;release?:string;hearing_impaired?:boolean;download_count?:number;upload_date?:string;feature_details?:{title?:string;year?:number;movie_name?:string;episode_number?:number;season_number?:number};files?:Array<{file_id?:number;file_name?:string}>}}> ; message?:string };
  if (!response.ok) throw new Error(payload.message || "Subtitle provider HTTP " + response.status);
  return (payload.data || []).slice(0, 30).map(item => {
    const a = item.attributes || {}; const f = a.files?.[0] || {};
    return { id: item.id || String(f.file_id || ""), fileId: f.file_id || null, fileName: f.file_name || "Subtitle file", language: a.language || "", release: a.release || "", title: a.feature_details?.movie_name || a.feature_details?.title || input.query, year: a.feature_details?.year || null, season: a.feature_details?.season_number || null, episode: a.feature_details?.episode_number || null, hearingImpaired: Boolean(a.hearing_impaired), downloads: a.download_count || 0, uploadedAt: a.upload_date || null, downloadRequiresProviderAuthorization: true };
  });
}

async function subtitleDownload(fileId: number, env: Env) {
  if (!env.OPENSUBTITLES_API_KEY || !env.OPENSUBTITLES_TOKEN) throw new Error("Subtitle download credentials are not configured.");
  const response = await fetch("https://api.opensubtitles.com/api/v1/download", { method: "POST", headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0", Authorization: "Bearer " + env.OPENSUBTITLES_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ file_id: fileId }), signal: AbortSignal.timeout(25000) });
  const payload = await response.json().catch(() => ({})) as { link?:string; file_name?:string; message?:string };
  if (!response.ok || !payload.link) throw new Error(payload.message || "Subtitle provider did not authorize this download.");
  const file = await fetch(payload.link, { signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error("Could not retrieve authorized subtitle file.");
  const filename = (payload.file_name || "subtitle.srt").replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(await file.arrayBuffer(), { headers: { "content-type": file.headers.get("content-type") || "application/octet-stream", "content-disposition": 'attachment; filename="' + filename + '"', "cache-control": "no-store", "X-AURORA-Provider": "backup-opensubtitles" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const originAllowed = allowedOrigins.has(origin);
    const cors = new Headers({ "cache-control": "no-store" });
    if (originAllowed) {
      cors.set("Access-Control-Allow-Origin", origin); cors.set("Vary", "Origin");
      cors.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); cors.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "aurora-voicetext-backup", status: "ok", providers: { transcription: Boolean(env.GROQ_API_KEY || env.OPENAI_API_KEY), speech: Boolean(env.OPENAI_API_KEY || env.ELEVENLABS_API_KEY), translation: Boolean(env.OPENAI_API_KEY || env.GROQ_API_KEY), transcriptPolish: Boolean(env.OPENAI_API_KEY || env.GROQ_API_KEY), subtitles: Boolean(env.OPENSUBTITLES_API_KEY), subtitleDownload: Boolean(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_TOKEN) } }, 200, cors);
    const routes = new Set(["/api/transcribe", "/api/tts", "/api/assist", "/api/translate", "/api/subtitles", "/api/subtitles-download"]);
    if (!routes.has(url.pathname)) return json({ error: "Not found." }, 404, cors);
    if (request.method !== "POST") { const methodHeaders = new Headers(cors); methodHeaders.set("Allow", "POST"); return json({ error: "Method not allowed." }, 405, methodHeaders); }
    const bearer = Boolean(env.BACKUP_API_TOKEN) && request.headers.get("authorization") === "Bearer " + env.BACKUP_API_TOKEN;
    const publicAllowed = env.BACKUP_PUBLIC_FALLBACK === "true" && originAllowed;
    if (!bearer && !publicAllowed) return json({ error: "Unauthorized or origin not allowed." }, 401, cors);
    const body = await request.json().catch(() => null) as (AudioBody & VoiceBody & TranslateBody & SubtitleBody & {fileId?:number}) | null;
    if (!body) return json({ error: "Invalid JSON request." }, 400, cors);
    try {
      if (url.pathname === "/api/transcribe") {
        if (typeof body.audioBase64 !== "string" || !body.audioBase64.length || body.audioBase64.length > 1800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audioBase64) || body.audioBase64.length % 4 !== 0) return json({ error: "Invalid or oversized audio payload." }, 400, cors);
        const mime = body.mimeType || "audio/wav";
        if (!["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"].includes(mime.toLowerCase())) return json({ error: "Unsupported audio format." }, 400, cors);
        const bytes = Uint8Array.from(atob(body.audioBase64), c => c.charCodeAt(0));
        const result = await transcribe(bytes, mime, env, body.languageHint);
        return json({ ...result, chunkNumber: body.chunkNumber || 1, totalChunks: body.totalChunks || 1 }, 200, cors);
      }
      if (url.pathname === "/api/tts") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 24000) return json({ error: "Text must contain 1–24,000 characters." }, 400, cors);
        const result = await synthesize(body, env);
        return new Response(result.audio, { headers: { ...Object.fromEntries(cors.entries()), "content-type": "audio/mpeg", "content-disposition": 'attachment; filename="aurora-voice.mp3"', "X-AURORA-Provider": result.provider } });
      }
      if (url.pathname === "/api/assist") {
        if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 24000) return json({ error: "Transcript must contain 1–24,000 characters." }, 400, cors);
        return json(await polishTranscript(body.text.trim(), env), 200, cors);
      }
      if (url.pathname === "/api/translate") {
        if (typeof body.text !== "string" || !body.text.trim() || typeof body.targetLanguage !== "string" || !body.targetLanguage.trim() || body.text.length > 24000) return json({ error: "Text and targetLanguage are required; maximum 24,000 characters." }, 400, cors);
        return json(await translate(body, env), 200, cors);
      }
      if (url.pathname === "/api/subtitles") {
        if (typeof body.query !== "string" || body.query.trim().length < 2 || body.query.length > 180) return json({ error: "Enter a title with 2–180 characters." }, 400, cors);
        return json({ results: await subtitleSearch(body, env), provider: "opensubtitles" }, 200, cors);
      }
      if (!Number.isInteger(body.fileId) || !body.fileId || body.fileId < 1) return json({ error: "A valid subtitle file ID is required." }, 400, cors);
      const file = await subtitleDownload(body.fileId, env);
      const headers = new Headers(file.headers); for (const [key, value] of cors) headers.set(key, value);
      return new Response(file.body, { status: file.status, headers });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message.slice(0, 450) : "Backup provider unavailable." }, 503, cors);
    }
  },
};
