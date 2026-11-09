import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { transcribeWithFallback } from "./_lib/transcription-providers.js";

type Job = {
  id: string; original_filename: string; mime_type: string; size_bytes: number;
  duration_seconds: number | null; storage_path: string; status: string;
  total_chunks: number; completed_chunks: number; transcript: string;
  error_message: string | null; created_at: string; updated_at: string; completed_at: string | null;
};
type Body = {
  action?: "transcribe" | "create" | "process";
  audioBase64?: string; mimeType?: string; languageHint?: string; requestId?: string;
  filename?: string; sizeBytes?: number; durationSeconds?: number; totalChunks?: number; chunkNumber?: number;
};

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4.5mb" } } };

function authorised(req: VercelRequest): boolean {
  const expected = process.env.AURORA_PLUGIN_TOKEN || "";
  const supplied = typeof req.headers.authorization === "string" ? req.headers.authorization.replace(/^Bearer\\s+/i, "") : "";
  if (!expected || !supplied) return false;
  const left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}
function dbConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || "voicetext-recordings";
  if (!url || !key) throw new Error("Persistent VoiceText jobs are not configured. Check the Supabase server environment.");
  return { url, key, bucket };
}
function headers(key: string, extra: Record<string,string> = {}) {
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...extra };
}
async function readJob(id: string): Promise<Job | null> {
  const { url, key } = dbConfig();
  const response = await fetch(url + "/rest/v1/voicetext_recordings?id=eq." + encodeURIComponent(id) + "&select=*", { headers: headers(key) });
  if (!response.ok) throw new Error("Could not read the saved transcription job.");
  const rows = await response.json() as Job[];
  return rows[0] || null;
}
async function updateJob(id: string, patch: Record<string, unknown>): Promise<Job> {
  const { url, key } = dbConfig();
  const response = await fetch(url + "/rest/v1/voicetext_recordings?id=eq." + encodeURIComponent(id), {
    method: "PATCH", headers: headers(key, { Prefer: "return=representation" }), body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("Could not save transcription job progress.");
  const rows = await response.json() as Job[];
  if (!rows[0]) throw new Error("The transcription job could not be found.");
  return rows[0];
}
function publicJob(job: Job) {
  return { requestId: job.id, status: job.status, totalChunks: job.total_chunks, completedChunks: job.completed_chunks,
    progress: job.total_chunks ? Math.round(job.completed_chunks / job.total_chunks * 100) : 0,
    transcript: job.transcript, error: job.error_message, createdAt: job.created_at, updatedAt: job.updated_at, completedAt: job.completed_at };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (!["GET", "POST"].includes(req.method || "")) { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!authorised(req)) return res.status(401).json({ error: "AURORA integration authentication failed." });

  const input = (req.body || {}) as Body;
  const action = input.action || "transcribe";
  const requestId = typeof (req.query.requestId || input.requestId) === "string" ? String(req.query.requestId || input.requestId) : "";
  if (req.method === "GET") {
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return res.status(400).json({ error: "A valid requestId is required." });
    try {
      const job = await readJob(requestId);
      return job ? res.status(200).json(publicJob(job)) : res.status(404).json({ error: "Transcription job not found." });
    } catch (error) { return res.status(503).json({ error: error instanceof Error ? error.message : "Job status is unavailable." }); }
  }

  if (action === "create") {
    const totalChunks = Number(input.totalChunks);
    const sizeBytes = Number(input.sizeBytes);
    const filename = String(input.filename || "recording").split(/[\\/]/).pop()!.slice(0, 180);
    const mimeType = String(input.mimeType || "audio/webm").toLowerCase();
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 2000 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return res.status(400).json({ error: "A valid recording size and section count are required." });
    }
    if (!/^audio\\/[a-z0-9.+-]+$/.test(mimeType)) return res.status(415).json({ error: "A supported audio MIME type is required." });
    try {
      const { url, key } = dbConfig();
      const id = /^[0-9a-f-]{36}$/i.test(input.requestId || "") ? input.requestId! : randomUUID();
      const storagePath = "aurora-jobs/" + id;
      const response = await fetch(url + "/rest/v1/voicetext_recordings", {
        method: "POST", headers: headers(key, { Prefer: "return=representation,resolution=ignore-duplicates" }),
        body: JSON.stringify({ id, original_filename: filename, mime_type: mimeType, size_bytes: sizeBytes,
          duration_seconds: Number.isFinite(input.durationSeconds) ? Math.max(0, Number(input.durationSeconds)) : null,
          storage_path: storagePath, status: "created", total_chunks: totalChunks, completed_chunks: 0, transcript: "" }),
      });
      if (!response.ok) throw new Error("Could not create a persistent transcription job. Confirm the VoiceText recordings table exists in Supabase.");
      const rows = await response.json() as Job[];
      const job = rows[0] || await readJob(id);
      if (!job) throw new Error("The transcription job was not returned by Supabase.");
      return res.status(201).json(publicJob(job));
    } catch (error) { return res.status(503).json({ error: error instanceof Error ? error.message : "Could not create a transcription job." }); }
  }

  if (action === "process") {
    const id = String(input.requestId || "");
    const chunkNumber = Number(input.chunkNumber), totalChunks = Number(input.totalChunks);
    const audioBase64 = typeof input.audioBase64 === "string" ? input.audioBase64 : "";
    const mimeType = String(input.mimeType || "").toLowerCase();
    const supported = new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"]);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(chunkNumber) || chunkNumber < 1 ||
        !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 2000 ||
        !audioBase64 || audioBase64.length > 4000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
      return res.status(400).json({ error: "A valid job ID and audio section are required." });
    }
    if (!supported.has(mimeType)) return res.status(415).json({ error: "Unsupported audio section format." });
    try {
      const job = await readJob(id);
      if (!job) return res.status(404).json({ error: "Transcription job not found." });
      if (job.status === "completed") return res.status(200).json(publicJob(job));
      if (job.total_chunks !== totalChunks) return res.status(409).json({ error: "Section count does not match the saved job." });
      if (chunkNumber <= job.completed_chunks) return res.status(200).json(publicJob(job));
      if (chunkNumber !== job.completed_chunks + 1) return res.status(409).json({ error: "Process sections in order. Resume from section " + (job.completed_chunks + 1) + ".", ...publicJob(job) });
      const { url, key, bucket } = dbConfig();
      const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("mpeg") || mimeType.includes("mp3") ? "mp3" : mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : mimeType.includes("aac") ? "aac" : "webm";
      const objectPath = job.storage_path + "/chunks/" + String(chunkNumber).padStart(5, "0") + "." + ext;
      const bytes = Buffer.from(audioBase64, "base64");
      const stored = await fetch(url + "/storage/v1/object/" + encodeURIComponent(bucket) + "/" + objectPath.split("/").map(encodeURIComponent).join("/"), {
        method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": mimeType, "x-upsert": "true" }, body: bytes,
      });
      if (!stored.ok) throw new Error("The audio section could not be saved to secure cloud storage.");
      const languageHint = typeof input.languageHint === "string" ? input.languageHint.trim().slice(0, 120) : undefined;
      const result = await transcribeWithFallback({ audioBase64, mimeType, languageHint });
      const transcript = [job.transcript.trim(), result.text.trim()].filter(Boolean).join(" ");
      const done = chunkNumber === totalChunks;
      const updated = await updateJob(id, { status: done ? "completed" : "processing", completed_chunks: chunkNumber,
        transcript, error_message: null, completed_at: done ? new Date().toISOString() : null });
      return res.status(200).json({ ...publicJob(updated), language: result.language || null, provider: result.provider });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message.slice(0, 420) : "This section could not be processed.",
        retryable: true, requestId: id, chunkNumber });
    }
  }

  if (action !== "transcribe") return res.status(400).json({ error: "Unknown action. Use create, process, or transcribe." });
  const audioBase64 = typeof input.audioBase64 === "string" ? input.audioBase64 : "";
  if (!audioBase64 || audioBase64.length > 4000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64) || audioBase64.length % 4 !== 0) {
    return res.status(audioBase64.length > 4000000 ? 413 : 400).json({ error: "Provide a valid audio section up to approximately 3 MB. Use persistent jobs for multi-section recordings." });
  }
  const mimeType = String(input.mimeType || "").toLowerCase();
  const supported = new Set(["audio/wav","audio/x-wav","audio/mpeg","audio/mp3","audio/ogg","audio/mp4","audio/aac","audio/webm"]);
  if (!supported.has(mimeType)) return res.status(415).json({ error: "VoiceText integration currently accepts audio files only. Convert video to an audio file first." });
  try {
    const result = await transcribeWithFallback({ audioBase64, mimeType, languageHint: typeof input.languageHint === "string" ? input.languageHint.trim().slice(0, 120) : undefined });
    return res.status(200).json({ requestId: input.requestId, text: result.text, language: result.language || null,
      segments: result.segments || [], provider: result.provider, completedAt: new Date().toISOString(), retention: "not_stored_by_integration_endpoint" });
  } catch (error) {
    const status = Number((error as { status?: number })?.status);
    return res.status(status >= 400 && status < 500 ? status : 503).json({
      error: error instanceof Error ? error.message.slice(0, 420) : "VoiceText transcription is temporarily unavailable.",
      retryable: status === 429 || status >= 500 || !status,
    });
  }
}
