import type { VercelRequest, VercelResponse } from "@vercel/node";
import { polishTranscriptWithFallback } from "./_lib/ai-providers.js";
import { callBackup } from "./_lib/backup.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as { text?: string };
  if (typeof input.text !== "string" || !input.text.trim()) return res.status(400).json({ error: "Transcript text is required." });
  if (input.text.length > 24000) return res.status(413).json({ error: "Please polish transcript sections of 24,000 characters or fewer." });
  try { return res.status(200).json(await polishTranscriptWithFallback({ text: input.text.trim() })); }
  catch (primaryError) {
    try {
      const backup = await callBackup("/api/assist", { text: input.text.trim() });
      if (backup?.ok) return res.status(200).json(await backup.json());
    } catch (error) { console.error("Backup transcript polishing failed", error); }
    const message = primaryError instanceof Error ? primaryError.message : "AI transcript polishing unavailable.";
    return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: true });
  }
}
