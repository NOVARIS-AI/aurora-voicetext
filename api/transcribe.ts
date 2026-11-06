import type { VercelRequest, VercelResponse } from "@vercel/node";
import { transcribeWithFallback } from "./_lib/transcription-providers.js";
import { callBackup } from "./_lib/backup.js";

type Body = { audioBase64?: string; mimeType?: string; chunkNumber?: number; totalChunks?: number; languageHint?: string; detectLanguage?: boolean; speakerLabels?: boolean };

// Long recordings are split into short, resumable sections by the client.
// Allow enough time for the primary providers and the authenticated Worker handoff.
export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowedOrigins = new Set(["https://localhost","http://localhost","capacitor://localhost","https://aurora-voicetext-qk8s.vercel.app","https://aurora-voicetext.vercel.app"]);
  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as Body;
  if (typeof input.audioBase64 !== "string" || !input.audioBase64.length) return res.status(400).json({ error: "Audio chunk is missing." });
  if (input.audioBase64.length > 1800000) return res.status(413).json({ error: "This audio chunk is too large. Please try again with a shorter audio segment." });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64) || input.audioBase64.length % 4 !== 0) return res.status(400).json({ error: "The audio upload is not valid base64 data. Please retry this section." });
  const mimeType = input.mimeType || "audio/wav";
  const supported = new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"]);
  if (!supported.has(mimeType.toLowerCase())) return res.status(400).json({ error: "Unsupported audio format: " + mimeType });
  if (input.chunkNumber !== undefined && (!Number.isInteger(input.chunkNumber) || input.chunkNumber < 1)) return res.status(400).json({ error: "Invalid audio section number." });
  if (input.totalChunks !== undefined && (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > 2000)) return res.status(400).json({ error: "Invalid total audio section count." });

  try {
    const result = await transcribeWithFallback({ audioBase64: input.audioBase64, mimeType, languageHint: input.languageHint });
    return res.status(200).json({ text: result.text, language: result.language, segments: result.segments, provider: result.provider, chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Primary transcription providers unavailable.";
    const status = (error as {status?:number}).status || 503;

    // Do not retry malformed or oversized chunks: the backup service would reject
    // the same payload. For provider/quota/network failures, hand this exact chunk
    // to the separately hosted Worker using a server-only bearer token.
    if (status !== 413 && status !== 415) {
      try {
        const backup = await callBackup("/api/transcribe", {
          audioBase64: input.audioBase64,
          mimeType,
          languageHint: input.languageHint,
          chunkNumber: input.chunkNumber ?? 1,
          totalChunks: input.totalChunks ?? 1,
        });
        if (backup) {
          const payload = await backup.json().catch(() => ({})) as {
            text?: string; language?: string; language_name?: string;
            segments?: unknown[]; provider?: string; error?: string;
          };
          if (backup.ok && typeof payload.text === "string" && payload.text.trim()) {
            return res.status(200).json({
              ...payload,
              text: payload.text.trim(),
              chunkNumber: input.chunkNumber ?? 1,
              totalChunks: input.totalChunks ?? 1,
              provider: payload.provider || "backup-worker",
              backupUsed: true,
            });
          }
          const backupMessage = typeof payload.error === "string" ? payload.error : "Backup transcription did not return a transcript.";
          return res.status(503).json({
            error: "Primary transcription failed. Backup service: " + backupMessage.slice(0, 300),
            fallbackAvailable: true,
            retryOnBackup: true,
          });
        }
      } catch (backupError) {
        const backupMessage = backupError instanceof Error ? backupError.message : "Backup request failed.";
        return res.status(503).json({
          error: "Primary transcription failed and the backup service could not be reached. " + backupMessage.slice(0, 240),
          fallbackAvailable: true,
          retryOnBackup: true,
        });
      }
    }

    // A missing server-side backup configuration can still use the explicitly
    // enabled, rate-limited client fallback. Never expose provider keys.
    return res.status(status >= 400 && status < 500 ? status : 503).json({
      error: message.slice(0, 420),
      fallbackAvailable: true,
      retryOnBackup: true,
    });
  }
}
