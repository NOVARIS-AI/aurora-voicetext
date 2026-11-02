export type VoiceRequest = { text: string; voice?: string; style?: string; rate?: number; pitch?: number; emotion?: string };
export type TranslationRequest = { text: string; targetLanguage: string; sourceLanguage?: string };
export type SubtitleSearchRequest = { query: string; languages?: string; type?: "movie" | "episode" };

function safeRate(value: unknown, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : fallback;
}

export async function synthesizeWithFallback(input: VoiceRequest): Promise<{ audio: Uint8Array; provider: string }> {
  const failures: string[] = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: "Bearer " + process.env.OPENAI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
          voice: input.voice || "alloy",
          input: input.text,
          response_format: "mp3",
          speed: safeRate(input.rate),
          instructions: [input.style, input.emotion, input.pitch ? "Pitch preference: " + input.pitch : ""].filter(Boolean).join(". ").slice(0, 800) || "Speak naturally and clearly.",
        }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("OpenAI speech returned HTTP " + response.status);
      return { audio: new Uint8Array(await response.arrayBuffer()), provider: "openai-tts" };
    } catch (error) { failures.push("OpenAI: " + (error instanceof Error ? error.message : "failed")); }
  }
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const voiceId = input.voice && /^[A-Za-z0-9_-]{5,80}$/.test(input.voice) ? input.voice : (process.env.ELEVENLABS_DEFAULT_VOICE_ID || "EXAVITQu4vr4xnSDxMaL");
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId), {
        method: "POST",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: input.text,
          model_id: process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true, speed: safeRate(input.rate) },
        }),
        signal: AbortSignal.timeout(110000),
      });
      if (!response.ok) throw new Error("ElevenLabs speech returned HTTP " + response.status);
      return { audio: new Uint8Array(await response.arrayBuffer()), provider: "elevenlabs" };
    } catch (error) { failures.push("ElevenLabs: " + (error instanceof Error ? error.message : "failed")); }
  }
  throw Object.assign(new Error(failures.join(" | ") || "No AI speech provider is configured. Add OPENAI_API_KEY or ELEVENLABS_API_KEY to the backend secrets."), { status: 503 });
}

export async function translateWithFallback(input: TranslationRequest): Promise<{ text: string; provider: string }> {
  const providers = [
    { name: "openai", key: process.env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini" },
    { name: "groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile" },
  ].filter(p => Boolean(p.key));
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: provider.model,
          temperature: 0.1,
          messages: [
            { role: "system", content: "Translate faithfully into the requested language. Preserve meaning, names, numbers, speaker labels, subtitle line breaks and timestamps. Do not add explanations or invent missing content." },
            { role: "user", content: "Source language: " + (input.sourceLanguage || "auto-detect") + "\nTarget language: " + input.targetLanguage + "\n\n" + input.text },
          ],
        }),
        signal: AbortSignal.timeout(90000),
      });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || provider.name + " returned HTTP " + response.status);
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(provider.name + " returned an empty translation.");
      return { text, provider: provider.name };
    } catch (error) { failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed")); }
  }
  throw Object.assign(new Error(failures.join(" | ") || "No translation provider is configured. Add OPENAI_API_KEY or GROQ_API_KEY."), { status: 503 });
}

export async function searchSubtitles(input: SubtitleSearchRequest) {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) throw Object.assign(new Error("Subtitle search is not configured yet. Add OPENSUBTITLES_API_KEY to the backend secrets."), { status: 503 });
  const url = new URL("https://api.opensubtitles.com/api/v1/subtitles");
  url.searchParams.set("query", input.query);
  url.searchParams.set("languages", (input.languages || "en").slice(0, 80));
  url.searchParams.set("order_by", "download_count");
  url.searchParams.set("order_direction", "desc");
  if (input.type) url.searchParams.set("type", input.type);
  const response = await fetch(url, {
    headers: { "Api-Key": key, "User-Agent": process.env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0" },
    signal: AbortSignal.timeout(25000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; attributes?: { language?: string; release?: string; hearing_impaired?: boolean; foreign_parts_only?: boolean; download_count?: number; upload_date?: string; feature_details?: { title?: string; year?: number; movie_name?: string; episode_number?: number; season_number?: number }; files?: Array<{ file_id?: number; file_name?: string }> } }>; message?: string };
  if (!response.ok) throw Object.assign(new Error(payload.message || "Subtitle provider returned HTTP " + response.status), { status: response.status });
  return (payload.data || []).slice(0, 30).map(item => {
    const a = item.attributes || {};
    const f = a.files?.[0] || {};
    return {
      id: item.id || String(f.file_id || ""),
      fileId: f.file_id || null,
      fileName: f.file_name || "Subtitle file",
      language: a.language || "",
      release: a.release || "",
      title: a.feature_details?.movie_name || a.feature_details?.title || input.query,
      year: a.feature_details?.year || null,
      season: a.feature_details?.season_number || null,
      episode: a.feature_details?.episode_number || null,
      hearingImpaired: Boolean(a.hearing_impaired),
      downloads: a.download_count || 0,
      uploadedAt: a.upload_date || null,
      downloadRequiresProviderAuthorization: true,
    };
  });
}


export async function polishTranscriptWithFallback(input: { text: string }): Promise<{ text: string; provider: string }> {
  const providers = [
    { name: "openai", key: process.env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: process.env.OPENAI_TRANSLATION_MODEL || "gpt-4o-mini" },
    { name: "groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: process.env.GROQ_TRANSLATION_MODEL || "llama-3.3-70b-versatile" },
  ].filter(p => Boolean(p.key));
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { Authorization: "Bearer " + provider.key, "Content-Type": "application/json" },
        body: JSON.stringify({ model: provider.model, temperature: 0.1, messages: [
          { role: "system", content: "Clean this speech transcript for readability. Correct punctuation, capitalization and obvious transcription formatting issues. Preserve every factual detail, sentence, name, number, language and Nigerian Pidgin expression. Do not summarize, add facts, translate, or omit content. Return only the corrected transcript." },
          { role: "user", content: input.text },
        ] }),
        signal: AbortSignal.timeout(90000),
      });
      const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!response.ok || !text) throw new Error(payload.error?.message || provider.name + " transcript cleanup failed.");
      return { text, provider: provider.name };
    } catch (error) { failures.push(provider.name + ": " + (error instanceof Error ? error.message : "failed")); }
  }
  throw Object.assign(new Error(failures.join(" | ") || "No AI text provider is configured. Add OPENAI_API_KEY or GROQ_API_KEY."), { status: 503 });
}
