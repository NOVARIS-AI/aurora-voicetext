import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const backupConfigured = Boolean(process.env.BACKUP_BACKEND_URL && process.env.BACKUP_BACKEND_TOKEN);
  const assemblyaiConfigured = Boolean(process.env.ASSEMBLYAI_API_KEY);
  const groqConfigured = Boolean(process.env.GROQ_API_KEY);
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  return res.status(200).json({
    app: "AURORA VoiceText",
    status: "ok",
    architecture: { primary: "vercel-functions", independentBackup: backupConfigured ? "configured" : "not-configured", providerKeysRemainServerSide: true },
    capabilities: {
      transcription: assemblyaiConfigured || groqConfigured || openaiConfigured,
      assemblyai: assemblyaiConfigured,
      groq: groqConfigured,
      openai: openaiConfigured,
      backupBackend: backupConfigured,
      aiSpeech: Boolean(openaiConfigured || process.env.ELEVENLABS_API_KEY),
      elevenLabs: Boolean(process.env.ELEVENLABS_API_KEY),
      translation: Boolean(openaiConfigured || groqConfigured),
      transcriptPolish: Boolean(openaiConfigured || groqConfigured),
      subtitleSearch: Boolean(process.env.OPENSUBTITLES_API_KEY),
      subtitleDownload: Boolean(process.env.OPENSUBTITLES_API_KEY && process.env.OPENSUBTITLES_TOKEN),
    },
    checkedAt: new Date().toISOString(),
  });
}
