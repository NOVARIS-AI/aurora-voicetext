// Provider secrets are synchronized by the GitHub Actions deployment workflow.
export interface Env {
  ASSEMBLYAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
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
  OPENSUBTITLES_USERNAME?: string;
  OPENSUBTITLES_PASSWORD?: string;
  OPENSUBTITLES_USER_AGENT?: string;
  BACKUP_API_TOKEN?: string;
  BACKUP_PUBLIC_FALLBACK?: string;
  TRANSCRIPTION_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
  GROQ_TRANSCRIPTION_MODEL?: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
  OPENAI_TTS_MODEL?: string;
  ELEVENLABS_TTS_MODEL?: string;
  OPENAI_TRANSLATION_MODEL?: string;
  GROQ_TRANSLATION_MODEL?: string;
  GROQ_CHAT_MODEL?: string;
  OPENROUTER_CHAT_MODEL?: string;
  OPENAI_CHAT_MODEL?: string;
}
type AudioBody = { audioBase64?: string; mimeType?: string; languageHint?: string; chunkNumber?: number; totalChunks?: number };
type VoiceBody = { text?: string; voice?: string; style?: string; rate?: number; pitch?: number; emotion?: string; language?: string };
type TranslateBody = { text?: string; targetLanguage?: string; sourceLanguage?: string };
type SubtitleBody = { query?: string; languages?: string; type?: "movie" | "episode" };
type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatBody = { messages?: ChatMessage[] };
const allowedOrigins = new Set(["https://aurora-voicetext.pages.dev","https://aurora-voicetext-qk8s.vercel.app","https://aurora-voicetext.vercel.app","capacitor://localhost","https://localhost","http://localhost"]);
const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...Object.fromEntries(new Headers(headers || {}).entries()) } });
const safeRate = (value: unknown) => Number.isFinite(Number(value)) ? Math.min(2, Math.max(0.5, Number(value))) : 1;

async function transcribe(bytes: Uint8Array, mime: string, env: Env, languageHint?: string) {
  const failures: string[] = [];
  // Keep the Worker request inside the Pages/Vercel proxy timeout, leaving
  // a small response margin so the caller receives the completed transcript.
  const requestDeadline = Date.now() + 105000;
  const remainingMs = () => Math.max(0, requestDeadline - Date.now());
  if (env.ASSEMBLYAI_API_KEY && remainingMs() > 12000) {
    try {
      const upload = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: { authorization: env.ASSEMBLYAI_API_KEY, "content-type": "application/octet-stream" },
        body: (() => { const uploadBytes = new Uint8Array(bytes.byteLength); uploadBytes.set(bytes); return uploadBytes.buffer; })(),
        signal: AbortSignal.timeout(Math.min(15000, remainingMs() - 1000)),
      });
      const uploaded = await upload.json().catch(() => ({})) as { upload_url?: string; error?: string };
      if (!upload.ok || !uploaded.upload_url) throw new Error(uploaded.error || "AssemblyAI upload failed (HTTP " + upload.status + ").");
      const submitted = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: env.ASSEMBLYAI_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          audio_url: uploaded.upload_url,
          speech_models: ["universal-3-5-pro", "universal-2"],
          language_detection: true,
          speaker_labels: true,
        }),
        signal: AbortSignal.timeout(Math.min(10000, remainingMs() - 1000)),
      });
      const job = await submitted.json().catch(() => ({})) as { id?: string; error?: string };
      if (!submitted.ok || !job.id) throw new Error(job.error || "AssemblyAI could not start transcription (HTTP " + submitted.status + ").");
      const assemblyDeadline = Math.min(requestDeadline, Date.now() + 45000);
      while (Date.now() < assemblyDeadline && remainingMs() > 9000) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const polled = await fetch("https://api.assemblyai.com/v2/transcript/" + encodeURIComponent(job.id), {
          headers: { authorization: env.ASSEMBLYAI_API_KEY },
          signal: AbortSignal.timeout(Math.min(8000, remainingMs() - 1500)),
        });
        const result = await polled.json().catch(() => ({})) as {
          status?: string; text?: string; language_code?: string; error?: string;
          utterances?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
        };
        if (!polled.ok) throw new Error(result.error || "AssemblyAI polling failed (HTTP " + polled.status + ").");
        if (result.status === "error") throw new Error(result.error || "AssemblyAI could not transcribe this audio.");
        if (result.status === "completed") {
          const segments = Array.isArray(result.utterances) ? result.utterances
            .filter(item => typeof item.start === "number" && typeof item.end === "number" && typeof item.text === "string")
            .map(item => ({
              start: item.start! / 1000,
              end: item.end! / 1000,
              text: item.text!.trim(),
              speaker: typeof item.speaker === "string" && item.speaker ? "Speaker " + item.speaker : undefined,
            })).filter(item => item.text.length > 0) : [];
          const text = (result.text || segments.map(item => item.text).join(" ")).trim();
          if (!text) throw new Error("AssemblyAI returned an empty transcript.");
          return { text, language: result.language_code, segments, provider: "assemblyai" };
        }
      }
      throw new Error("AssemblyAI is still processing this section; the Worker will now hand off to the configured speech-provider fallbacks.");
    } catch (error) {
      failures.push("assemblyai: " + (error instanceof Error ? error.message : "request failed"));
    }
  }
  const providers = [
    { key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3-turbo", name: "groq" },
    { key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/audio/transcriptions", model: env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1", name: "openai" },
  ].filter(p => p.key);
  if (!providers.length) throw new Error("No backup transcription provider configured. " + failures.join(" | "));
  for (const provider of providers) {
    // Reserve enough time for the next provider and the JSON response. Never
    // let one slow provider consume the entire Worker request window.
    if (remainingMs() < 4000) {
      failures.push(provider.name + ": skipped because the backup request time budget was exhausted.");
      break;
    }
    try {
      const form = new FormData();
      const audio = new Uint8Array(bytes.byteLength); audio.set(bytes);
      const ext = mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "wav";
      form.append("file", new Blob([audio.buffer], { type: mime }), "audio-chunk." + ext);
      form.append("model", provider.model); form.append("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); form.append("temperature", "0");
      if (languageHint) form.append("prompt", "Transcribe accurately. Preserve the spoken language. " + languageHint.slice(0, 120));
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key }, body: form, signal: AbortSignal.timeout(Math.min(45000, remainingMs() - 1500)) });
      const payload = await response.json().catch(() => ({})) as { text?: string; language?: string; segments?: Array<{start?:number;end?:number;text?:string}>; error?: {message?:string}|string };
      if (!response.ok || !payload.text?.trim()) {
        const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
        throw Object.assign(new Error(message || provider.name + " transcription failed."), { status: response.status });
      }
      return { text: payload.text.trim(), language: payload.language, segments: Array.isArray(payload.segments) ? payload.segments.filter(s => typeof s.start === "number" && typeof s.end === "number" && typeof s.text === "string") : [], provider: provider.name };
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
        body: JSON.stringify({ model: env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts", voice: input.voice || "alloy", input: text, response_format: "mp3", speed: safeRate(input.rate), instructions: [input.language && input.language !== "Auto-detect" ? "Speak in " + input.language + ". Keep the language and original wording; do not translate." : "Detect the language from the supplied script and speak it naturally.", input.style, input.emotion, input.pitch ? "Pitch preference: " + input.pitch : ""].filter(Boolean).join(". ").slice(0, 800) || "Speak naturally and clearly." }),
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
    { name: "openrouter", key: env.OPENROUTER_API_KEY, url: "https://openrouter.ai/api/v1/chat/completions", model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini", headers: { "HTTP-Referer": "https://aurora-voicetext.pages.dev", "X-Title": "AURORA VoiceText" } },
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini", headers: {} },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile", headers: {} },
  ].filter(p => p.key);
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json", ...provider.headers }, body: JSON.stringify({ model: provider.model, temperature: 0.1, messages: [{ role: "system", content: "Translate faithfully. Preserve meaning, names, numbers, speaker labels, subtitle line breaks and timestamps. Do not add explanations or invent missing content." }, { role: "user", content: "Source language: " + (input.sourceLanguage || "auto-detect") + "\nTarget language: " + input.targetLanguage + "\n\n" + input.text }] }), signal: AbortSignal.timeout(90000) });
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
    { name: "openrouter", key: env.OPENROUTER_API_KEY, url: "https://openrouter.ai/api/v1/chat/completions", model: env.OPENROUTER_MODEL || "openai/gpt-4o-mini", headers: { "HTTP-Referer": "https://aurora-voicetext.pages.dev", "X-Title": "AURORA VoiceText" } },
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini", headers: {} },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile", headers: {} },
  ].filter(p => p.key);
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, { method: "POST", headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json", ...provider.headers }, body: JSON.stringify({ model: provider.model, temperature: 0.1, messages: [
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

async function voiceChat(input: ChatBody, env: Env): Promise<{ text: string; provider: string }> {
  const messages = Array.isArray(input.messages)
    ? input.messages.filter((item): item is ChatMessage =>
        Boolean(item) && (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string"
      ).slice(-16).map(item => ({ role: item.role, content: item.content.trim().slice(0, 12000) }))
    : [];
  if (!messages.length || !messages.some(item => item.role === "user" && item.content)) {
    throw Object.assign(new Error("Write a message before chatting with AURORA."), { status: 400 });
  }
  if (messages.reduce((total, item) => total + item.content.length, 0) > 24000) {
    throw Object.assign(new Error("This conversation is too long. Start a fresh chat or shorten your message."), { status: 413 });
  }
  const system = "You are AURORA, a helpful, natural conversational AI inside AURORA VoiceText. Answer the user's actual question directly and warmly. When asked to write something for speech, produce a polished, natural spoken script. Preserve the user's requested language, names, facts and tone. Do not claim to have generated audio; the app handles speech generation separately. Keep ordinary answers concise unless detail is requested.";
  const providers = [
    { name: "openrouter", key: env.OPENROUTER_API_KEY, url: "https://openrouter.ai/api/v1/chat/completions", model: env.OPENROUTER_CHAT_MODEL || env.OPENROUTER_MODEL || "openai/gpt-4o-mini", headers: { "HTTP-Referer": "https://aurora-voicetext.pages.dev", "X-Title": "AURORA VoiceText" } },
    { name: "groq", key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile", headers: {} },
    { name: "openai", key: env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: env.OPENAI_CHAT_MODEL || "gpt-4o-mini", headers: {} },
  ].filter(provider => Boolean(provider.key));
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json", ...provider.headers },
        body: JSON.stringify({ model: provider.model, temperature: 0.65, max_tokens: 1400, messages: [{ role: "system", content: system }, ...messages] }),
        signal: AbortSignal.timeout(60000),
      });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!response.ok || !text) throw new Error(payload.error?.message || provider.name + " chat returned an empty response.");
      return { text, provider: provider.name };
    } catch (error) {
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "request failed"));
    }
  }
  throw Object.assign(new Error(failures.join(" | ") || "AI chat is not configured. Add GROQ_API_KEY or OPENAI_API_KEY to the backup Worker secrets."), { status: 503 });
}

async function subtitleSearch(input: SubtitleBody, env: Env) {
  if (!env.OPENSUBTITLES_API_KEY) throw new Error("Subtitle search provider is not configured.");
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", input.query!); url.searchParams.set("languages", (input.languages || "en").slice(0, 80)); url.searchParams.set("order_by", "download_count"); url.searchParams.set("order_direction", "desc");
  if (input.type) url.searchParams.set("type", input.type);
  const response = await fetch(url, { headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0", "Accept": "application/json" }, signal: AbortSignal.timeout(25000) });
  const payload = await response.json().catch(() => ({})) as { data?: Array<{id?:string;attributes?:{language?:string;release?:string;hearing_impaired?:boolean;download_count?:number;upload_date?:string;feature_details?:{title?:string;year?:number;movie_name?:string;episode_number?:number;season_number?:number};files?:Array<{file_id?:number;file_name?:string}>}}> ; message?:string };
  if (!response.ok) {
    const message = payload.message || "Subtitle provider HTTP " + response.status;
    const error = new Error(response.status === 403
      ? "OpenSubtitles rejected the API key (HTTP 403). The saved OPENSUBTITLES_API_KEY may be invalid, disabled, or not an OpenSubtitles.com API consumer key. Check the key in GitHub Secrets; do not change the account password for this search error."
      : message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (payload.data || []).slice(0, 30).map(item => {
    const a = item.attributes || {}; const f = a.files?.[0] || {};
    return { id: item.id || String(f.file_id || ""), fileId: f.file_id || null, fileName: f.file_name || "Subtitle file", language: a.language || "", release: a.release || "", title: a.feature_details?.movie_name || a.feature_details?.title || input.query, year: a.feature_details?.year || null, season: a.feature_details?.season_number || null, episode: a.feature_details?.episode_number || null, hearingImpaired: Boolean(a.hearing_impaired), downloads: a.download_count || 0, uploadedAt: a.upload_date || null, downloadRequiresProviderAuthorization: true };
  });
}

async function subtitleDownload(fileId: number, env: Env) {
  if (!env.OPENSUBTITLES_API_KEY || !env.OPENSUBTITLES_USERNAME || !env.OPENSUBTITLES_PASSWORD) {
    throw new Error("Subtitle downloads need the OpenSubtitles API key plus the account username and password configured as backend secrets.");
  }
  const userAgent = env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0";
  // OpenSubtitles issues short-lived bearer tokens through POST /login.
  // Credentials remain in Worker secrets and are never sent to the client.
  const login = await fetch("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": userAgent, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: env.OPENSUBTITLES_USERNAME, password: env.OPENSUBTITLES_PASSWORD }),
    signal: AbortSignal.timeout(20000),
  });
  const session = await login.json().catch(() => ({})) as { token?: string; base_url?: string; message?: string };
  if (!login.ok || !session.token) {
    const reason = login.status === 401 || login.status === 400
      ? "OpenSubtitles account login was rejected. Check the saved account username and password."
      : (session.message || "OpenSubtitles could not create an authenticated session (HTTP " + login.status + ").");
    throw new Error(reason);
  }
  const host = session.base_url === "vip-api.opensubtitles.com" ? "https://vip-api.opensubtitles.com" : "https://api.opensubtitles.com";
  // The OpenSubtitles edge occasionally returns transient 502/503/504
  // responses before its download API handles the request. Retry once only
  // for those transient statuses; never retry authorization/client errors.
  let response: Response | null = null;
  let responseText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(host + "/api/v1/download", {
        method: "POST",
        headers: { "Api-Key": env.OPENSUBTITLES_API_KEY, "User-Agent": userAgent, Authorization: "Bearer " + session.token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(25000),
      });
      if (response.ok) break;
      responseText = await response.text().catch(() => "");
      if (![502, 503, 504].includes(response.status) || attempt === 1) break;
      await new Promise(resolve => setTimeout(resolve, 1200));
    } catch (error) {
      if (attempt === 1) throw Object.assign(new Error("OpenSubtitles download request failed at the network layer after one retry: " + (error instanceof Error ? error.message : "network error")), { status: 503 });
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  if (!response) throw Object.assign(new Error("OpenSubtitles download request did not return a response."), { status: 503 });
  responseText = await response.text().catch(() => responseText);
  const payload = (() => { try { return JSON.parse(responseText || "{}") as { link?:string; file_name?:string; message?:string }; } catch { return {} as { link?:string; file_name?:string; message?:string }; } })();
  if (!response.ok || !payload.link) {
    const transient = [502, 503, 504].includes(response.status);
    const detail = (payload.message || responseText.replace(/<[^>]*>/g, " ").replace(/\\s+/g, " ").trim()).slice(0, 180);
    const ray = response.headers.get("cf-ray");
    const retryAfter = response.headers.get("retry-after");
    const server = response.headers.get("server");
    const diagnostic = [
      "OpenSubtitles " + (transient ? "temporarily failed" : "rejected") + " the download request (HTTP " + response.status + ").",
      "Host: " + host.replace("https://", "") + ".",
      ray ? "Request ID: " + ray + "." : "",
      retryAfter ? "Retry-After: " + retryAfter + "." : "",
      server ? "Edge: " + server + "." : "",
      detail ? "Provider detail: " + detail : "",
      transient ? "Please try again later; AURORA already retried once." : "",
    ].filter(Boolean).join(" ");
    throw Object.assign(new Error(diagnostic), { status: response.status >= 400 && response.status < 500 ? response.status : 503 });
  }
  const file = await fetch(payload.link, { signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error("Could not retrieve the authorized subtitle file.");
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
    if (url.pathname === "/health" && request.method === "GET") return json({ service: "aurora-voicetext-backup", status: "ok", providers: { transcription: Boolean(env.ASSEMBLYAI_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY), assemblyai: Boolean(env.ASSEMBLYAI_API_KEY), speech: Boolean(env.OPENAI_API_KEY || env.ELEVENLABS_API_KEY), openrouter: Boolean(env.OPENROUTER_API_KEY), translation: Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.GROQ_API_KEY), transcriptPolish: Boolean(env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.GROQ_API_KEY), voiceChat: Boolean(env.OPENROUTER_API_KEY || env.GROQ_API_KEY || env.OPENAI_API_KEY), subtitles: Boolean(env.OPENSUBTITLES_API_KEY), subtitleDownload: Boolean(env.OPENSUBTITLES_API_KEY && env.OPENSUBTITLES_USERNAME && env.OPENSUBTITLES_PASSWORD) } }, 200, cors);
    const routes = new Set(["/api/transcribe", "/api/tts", "/api/assist", "/api/translate", "/api/voice-chat", "/api/subtitles", "/api/subtitles-download"]);
    if (!routes.has(url.pathname)) return json({ error: "Not found." }, 404, cors);
    if (request.method !== "POST") { const methodHeaders = new Headers(cors); methodHeaders.set("Allow", "POST"); return json({ error: "Method not allowed." }, 405, methodHeaders); }
    const bearer = Boolean(env.BACKUP_API_TOKEN) && request.headers.get("authorization") === "Bearer " + env.BACKUP_API_TOKEN;
    // APK clients cannot contain the private Worker token. Allow only transcription
    // through an explicit rate-limited binding; all other routes remain bearer-only.
    let publicTranscriptionAllowed = false;
    if (!bearer && url.pathname === "/api/transcribe" && originAllowed && env.TRANSCRIPTION_LIMITER) {
      const clientIp = request.headers.get("cf-connecting-ip") || "unknown-client";
      try {
        const limit = await env.TRANSCRIPTION_LIMITER.limit({ key: clientIp });
        publicTranscriptionAllowed = limit.success;
        if (!limit.success) {
          const limitedHeaders = new Headers(cors);
          limitedHeaders.set("Retry-After", "60");
          return json({ error: "Too many transcription sections from this network. Wait one minute, then continue." }, 429, limitedHeaders);
        }
      } catch {
        return json({ error: "The backup transcription rate limiter is temporarily unavailable." }, 503, cors);
      }
    }
    if (!bearer && !publicTranscriptionAllowed) return json({ error: "Unauthorized or origin not allowed." }, 401, cors);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (url.pathname === "/api/transcribe" && contentLength > 2_000_000) return json({ error: "Audio request is too large." }, 413, cors);
    const body = await request.json().catch(() => null) as (AudioBody & VoiceBody & TranslateBody & SubtitleBody & ChatBody & {fileId?:number}) | null;
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
      if (url.pathname === "/api/voice-chat") {
        return json(await voiceChat(body, env), 200, cors);
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
      const requestedStatus = (error as { status?: number }).status;
      const status = requestedStatus && requestedStatus >= 400 && requestedStatus < 500 ? requestedStatus : 503;
      return json({ error: error instanceof Error ? error.message.slice(0, 450) : "Backup provider unavailable." }, status, cors);
    }
  },
};

// Redeploy marker: refresh Worker secrets after the latest GitHub Secrets update.
