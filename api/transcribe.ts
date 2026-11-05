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
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) return res.status(400).json({ error: "The audio upload is not valid base64 data. Please retry this section." });
  const decodedAudioBytes = Buffer.from(input.audioBase64, "base64");
  if (!decodedAudioBytes.byteLength) return res.status(400).json({ error: "The audio upload is empty. Please select the recording again." });
  if (decodedAudioBytes.byteLength > 1_350_000) return res.status(413).json({ error: "This audio section is too large after decoding. Please retry with shorter sections." });
  const mimeType = input.mimeType || "audio/wav";
  const supported = new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"]);
  if (!supported.has(mimeType.toLowerCase())) return res.status(400).json({ error: "Unsupported audio format: " + mimeType });
  if (input.chunkNumber !== undefined && (!Number.isInteger(input.chunkNumber) || input.chunkNumber < 1)) return res.status(400).json({ error: "Invalid audio section number." });
  if (input.totalChunks !== undefined && (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > 2000)) return res.status(400).json({ error: "Invalid total audio section count." });

  const languageHint = typeof input.languageHint === "string" ? input.languageHint.trim().slice(0, 120) : undefined;
  try {
    const result = await transcribeWithFallback({
      audioBase64: input.audioBase64,
      mimeType,
      languageHint,
      speakerLabels: input.speakerLabels !== false,
    });
    return res.status(200).json({ text: result.text, language: result.language, segments: result.segments, provider: result.provider, chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Primary transcription providers unavailable.";
    const status = (error as {status?:number}).status || 503;
    // The Android/web client sees this 5xx and immediately hands the same
    // section to the separately hosted Cloudflare Worker. Do not proxy that
    // long-running request through a 60-second Vercel function.
    return res.status(status >= 400 && status < 500 ? status : 503).json({
      error: message.slice(0, 420),
      fallbackAvailable: true,
      retryOnBackup: true,
    });
  }
}
