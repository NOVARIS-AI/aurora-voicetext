import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTranscriptionHealth } from "./_lib/transcription-health.mjs";
import { getBackupHealth } from "./_lib/backup-health.mjs";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");
  const transcriptionHealth = getTranscriptionHealth(process.env);
  const backupHealth = await getBackupHealth(process.env);
  const providers = transcriptionHealth.providers;
  const primaryAvailable = transcriptionHealth.onlineTranscriptionAvailable;
  const backupAvailable = backupHealth.status === "ok" &&
    Boolean(backupHealth.providers?.transcription);

  return res.status(200).json({
    app: "AURORA VoiceText",
    status: primaryAvailable || backupAvailable ? "ok" : "degraded",
    architecture: {
      primary: "vercel-functions",
      independentBackup: backupHealth.status,
      providerKeysRemainServerSide: true,
    },
    transcriptionHealth,
    backupHealth,
    capabilities: {
      transcription: primaryAvailable || backupAvailable,
      primaryTranscription: primaryAvailable,
      backupTranscription: backupAvailable,
      assemblyai: providers.assemblyai,
      groq: providers.groq,
      openai: providers.openai,
      backupBackend: backupHealth.status === "ok",
      aiSpeech: Boolean(providers.openai || process.env.ELEVENLABS_API_KEY ||
        backupHealth.providers?.speech),
      elevenLabs: Boolean(process.env.ELEVENLABS_API_KEY),
      translation: Boolean(providers.openai || providers.groq ||
        backupHealth.providers?.translation),
      transcriptPolish: Boolean(providers.openai || providers.groq ||
        backupHealth.providers?.transcriptPolish),
      subtitleSearch: Boolean(process.env.OPENSUBTITLES_API_KEY ||
        backupHealth.providers?.subtitles),
      subtitleDownload: Boolean(
        (process.env.OPENSUBTITLES_API_KEY && process.env.OPENSUBTITLES_TOKEN) ||
        backupHealth.providers?.subtitleDownload
      ),
    },
    checkedAt: new Date().toISOString(),
  });
}