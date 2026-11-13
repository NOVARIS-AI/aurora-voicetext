import type { VercelRequest, VercelResponse } from "@vercel/node";
import { assistDocumentWithFallback, polishTranscriptWithFallback } from "./_lib/ai-providers.js";
import { callBackup } from "./_lib/backup.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as { text?: string; language?: string; instruction?: string; task?: string };
  if (typeof input.text !== "string" || !input.text.trim()) return res.status(400).json({ error: "Document text is required." });
  if (input.text.length > 24000) return res.status(413).json({ error: "Please work with document sections of 24,000 characters or fewer." });
  const text = input.text.trim();
  if (typeof input.instruction === "string" && input.instruction.trim()) {
    if (input.instruction.length > 1200) return res.status(400).json({ error: "Please shorten the instruction." });
    try { return res.status(200).json(await assistDocumentWithFallback({ text, instruction: input.instruction.trim(), task: input.task })); }
    catch (primaryError) {
      const message = primaryError instanceof Error ? primaryError.message : "AI document assistance unavailable.";
      return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: false });
    }
  }
  try { return res.status(200).json(await polishTranscriptWithFallback({ text, language: input.language })); }
  catch (primaryError) {
    try {
      const backup = await callBackup("/api/assist", { text, language: input.language });
      if (backup?.ok) return res.status(200).json(await backup.json());
    } catch (error) { console.error("Backup transcript polishing failed", error); }
    const message = primaryError instanceof Error ? primaryError.message : "AI transcript polishing unavailable.";
    return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: true });
  }
}
