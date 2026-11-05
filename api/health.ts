import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTranscriptionHealth } from "./_lib/transcription-health.mjs";

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }
  res.setHeader("Cache-Control", "no-store");
  const backupConfigured = Boolean(process.env.BACKUP_BACKEND_URL && process.env.BACKUP_BACKEND_TOKEN);
  const transcriptionHealth = getTranscriptionHealth(process.env);
  const assemblyaiConfigured = transcriptionHealth.providers.assemblyai;
  const groqConfigured = transcriptionHealth.providers.groq;
  const openaiConfigured = transcriptionHealth.providers.openai;
  return res.status(200).json({
    app: "AURORA VoiceText",
    status: "ok",
    architecture: {
      primary: "vercel-functions",
      independentBackup: backupConfigured ? "configured" : "not-configured",
      providerKeysRemainServerSide: true,
    },
    transcriptionHealth,
    capabilities: {
      transcription: transcriptionHealth.onlineTranscriptionAvailable,
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
