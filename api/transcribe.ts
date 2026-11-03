import type { VercelRequest, VercelResponse } from "@vercel/node";
import { transcribeWithFallback } from "./_lib/transcription-providers";

type Body = { audioBase64?: string; mimeType?: string; chunkNumber?: number; totalChunks?: number; languageHint?: string; detectLanguage?: boolean; speakerLabels?: boolean };

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
    const primary = await transcribeWithFallback({ audioBase64: input.audioBase64, mimeType, languageHint: input.languageHint });
    return res.status(200).json({ text: primary.text, language: primary.language, segments: primary.segments, provider: primary.provider, chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
  } catch (primaryError) {
    const backupUrl = process.env.BACKUP_BACKEND_URL?.replace(/\/$/, "");
    const backupToken = process.env.BACKUP_BACKEND_TOKEN;
    if (backupUrl && backupToken) {
      try {
        const backup = await fetch(backupUrl + "/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + backupToken },
          body: JSON.stringify({ audioBase64: input.audioBase64, mimeType, languageHint: input.languageHint, chunkNumber: input.chunkNumber, totalChunks: input.totalChunks }),
          signal: AbortSignal.timeout(115000),
        });
        const result = await backup.json().catch(() => ({})) as { text?: string; language?: string; language_name?: string; segments?: Array<{start?:number;end?:number;text?:string;speaker?:string;speaker_id?:string}>; error?: string; provider?: string };
        if (backup.ok && typeof result.text === "string" && result.text.trim()) {
          return res.status(200).json({ text: result.text.trim(), language: result.language_name || result.language, segments: Array.isArray(result.segments) ? result.segments : [], provider: "backup-" + (result.provider || "worker"), chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
        }
        console.error("Backup transcription backend failed", backup.status, result.error || "invalid response");
      } catch (backupError) { console.error("Backup backend unavailable", backupError); }
    }
    const message = primaryError instanceof Error ? primaryError.message : "Transcription providers unavailable.";
    const status = (primaryError as {status?:number}).status || 502;
    return res.status(status >= 400 && status < 500 ? status : 503).json({
      error: backupUrl && backupToken ? "Primary and backup transcription services are unavailable. " + message.slice(0, 220) : message.slice(0, 420),
      fallbackAvailable: Boolean(backupUrl && backupToken),
    });
  }
}
