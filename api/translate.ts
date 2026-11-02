import type { VercelRequest, VercelResponse } from "@vercel/node";
import { translateWithFallback, type TranslationRequest } from "./_lib/ai-providers";
import { callBackup } from "./_lib/backup";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as TranslationRequest;
  if (typeof input.text !== "string" || !input.text.trim() || typeof input.targetLanguage !== "string" || !input.targetLanguage.trim()) return res.status(400).json({ error: "Text and targetLanguage are required." });
  if (input.text.length > 24000) return res.status(413).json({ error: "Please translate sections of 24,000 characters or fewer." });
  const normalized = { ...input, text: input.text.trim(), targetLanguage: input.targetLanguage.trim().slice(0, 80), sourceLanguage: input.sourceLanguage?.slice(0, 80) };
  try { return res.status(200).json(await translateWithFallback(normalized)); }
  catch (primaryError) {
    try {
      const backup = await callBackup("/api/translate", normalized);
      if (backup?.ok) return res.status(200).json(await backup.json());
    } catch (error) { console.error("Backup translation failed", error); }
    const message = primaryError instanceof Error ? primaryError.message : "Translation providers unavailable.";
    return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: true });
  }
}
