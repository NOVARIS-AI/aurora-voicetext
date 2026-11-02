import type { VercelRequest, VercelResponse } from "@vercel/node";
import { synthesizeWithFallback, type VoiceRequest } from "./_lib/ai-providers";
import { callBackup } from "./_lib/backup";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as VoiceRequest;
  if (typeof input.text !== "string" || !input.text.trim()) return res.status(400).json({ error: "Text is required." });
  if (input.text.length > 24000) return res.status(413).json({ error: "Please split text into sections of 24,000 characters or fewer." });
  const normalized = { ...input, text: input.text.trim(), rate: Math.min(2, Math.max(0.5, Number(input.rate) || 1)) };
  try {
    const result = await synthesizeWithFallback(normalized);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="aurora-voice.mp3"');
    res.setHeader("X-AURORA-Provider", result.provider);
    return res.status(200).send(Buffer.from(result.audio));
  } catch (primaryError) {
    try {
      const backup = await callBackup("/api/tts", normalized);
      if (backup?.ok) {
        res.setHeader("Content-Type", backup.headers.get("content-type") || "audio/mpeg");
        res.setHeader("Content-Disposition", 'attachment; filename="aurora-voice.mp3"');
        res.setHeader("X-AURORA-Provider", "backup-" + (backup.headers.get("X-AURORA-Provider") || "worker"));
        return res.status(200).send(Buffer.from(await backup.arrayBuffer()));
      }
    } catch (error) { console.error("Backup TTS failed", error); }
    const message = primaryError instanceof Error ? primaryError.message : "AI speech providers unavailable.";
    return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: true });
  }
}
