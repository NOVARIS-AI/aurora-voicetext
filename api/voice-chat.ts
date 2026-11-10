import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callBackup } from "./_lib/backup.js";

type ChatMessage = { role: "user" | "assistant"; content: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as { messages?: ChatMessage[] };
  const messages = Array.isArray(input.messages)
    ? input.messages.filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
        .slice(-16).map(item => ({ role: item.role, content: item.content.trim().slice(0, 12000) }))
    : [];
  if (!messages.length || !messages.some(item => item.role === "user" && item.content)) {
    return res.status(400).json({ error: "Write a message before chatting with AURORA." });
  }
  if (messages.reduce((total, item) => total + item.content.length, 0) > 24000) {
    return res.status(413).json({ error: "This conversation is too long. Start a fresh chat or shorten your message." });
  }
  const system = "You are AURORA, a helpful, natural conversational AI inside AURORA VoiceText. Answer the user's actual question directly and warmly. When asked to write something for speech, produce a polished, natural spoken script. Preserve the user's requested language, names, facts and tone. Do not claim to have generated audio; the app handles speech generation separately. Keep ordinary answers concise unless detail is requested.";
  const providers = [
    { name: "OpenRouter", key: process.env.OPENROUTER_API_KEY, url: "https://openrouter.ai/api/v1/chat/completions", model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini", headers: { "HTTP-Referer": "https://aurora-voicetext.pages.dev", "X-Title": "AURORA VoiceText" } },
    { name: "Groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile", headers: {} },
    { name: "OpenAI", key: process.env.OPENAI_API_KEY, url: "https://api.openai.com/v1/chat/completions", model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini", headers: {} },
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
      return res.status(200).json({ text, provider: provider.name.toLowerCase() });
    } catch (error) {
      failures.push(provider.name + ": " + (error instanceof Error ? error.message : "request failed"));
    }
  }
  try {
    const backup = await callBackup("/api/voice-chat", { messages });
    if (backup?.ok) {
      const payload = await backup.json().catch(() => ({})) as { text?: string; provider?: string; error?: string };
      if (typeof payload.text === "string" && payload.text.trim()) {
        return res.status(200).json({ text: payload.text.trim(), provider: payload.provider || "backup-worker", backupUsed: true });
      }
    }
  } catch (error) {
    failures.push("Backup Worker: " + (error instanceof Error ? error.message : "request failed"));
  }
  return res.status(503).json({ error: failures.join(" | ") || "AI chat is not configured. Add GROQ_API_KEY or OPENAI_API_KEY to the server environment." });
}
