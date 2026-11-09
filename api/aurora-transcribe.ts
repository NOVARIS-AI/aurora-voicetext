import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";
import { transcribeWithFallback } from "./_lib/transcription-providers.js";

type Body = {
  audioBase64?: string;
  mimeType?: string;
  languageHint?: string;
  requestId?: string;
};

export const config = {
  maxDuration: 60,
  api: { bodyParser: { sizeLimit: "2mb" } },
};

function authorised(req: VercelRequest): boolean {
  const expected = process.env.AURORA_PLUGIN_TOKEN || "";
  const supplied = typeof req.headers.authorization === "string"
    ? req.headers.authorization.replace(/^Bearer\s+/i, "")
    : "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  if (!authorised(req)) return res.status(401).json({ error: "AURORA integration authentication failed." });

  const input = (req.body || {}) as Body;
  const audioBase64 = typeof input.audioBase64 === "string" ? input.audioBase64 : "";
  if (!audioBase64 || audioBase64.length > 1800000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
    return res.status(audioBase64.length > 1800000 ? 413 : 400).json({ error: "Provide a valid audio section within the 1.8 MB encoded limit." });
  }
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "";
  const supported = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/mp4", "audio/aac", "audio/webm"]);
  if (!supported.has(mimeType)) return res.status(415).json({ error: "VoiceText integration currently accepts audio files only. Convert video to an audio file first." });
  const languageHint = typeof input.languageHint === "string" ? input.languageHint.trim().slice(0, 120) : undefined;
  const requestId = typeof input.requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId) ? input.requestId : undefined;

  try {
    const result = await transcribeWithFallback({ audioBase64, mimeType, languageHint });
    return res.status(200).json({
      requestId,
      text: result.text,
      language: result.language || null,
      segments: result.segments || [],
      provider: result.provider,
      completedAt: new Date().toISOString(),
      retention: "not_stored_by_integration_endpoint",
    });
  } catch (error) {
    const status = Number((error as { status?: number })?.status);
    return res.status(status >= 400 && status < 500 ? status : 503).json({
      error: error instanceof Error ? error.message.slice(0, 420) : "VoiceText transcription is temporarily unavailable.",
      retryable: status === 429 || status >= 500 || !status,
    });
  }
}
