import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    app: "AURORA VoiceText",
    status: "ok",
    capabilities: {
      transcription: Boolean(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      backupBackend: Boolean(process.env.BACKUP_BACKEND_URL && process.env.BACKUP_BACKEND_TOKEN),
      aiSpeech: Boolean(process.env.OPENAI_API_KEY || process.env.ELEVENLABS_API_KEY),
      translation: Boolean(process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY),
    },
    checkedAt: new Date().toISOString(),
  });
}
