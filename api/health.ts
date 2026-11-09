import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTranscriptionHealth } from "./_lib/transcription-health.mjs";
import { getBackupHealth } from "./_lib/backup-health.mjs";
import { requireAdmin } from "./_lib/admin-auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET" && req.query.scope === "supabase") {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || "voicetext-recordings";
    if (!url || !key) return res.status(503).json({ ok: false, configured: false, error: "Supabase server environment variables are missing." });
    try {
      const response = await fetch(url.replace(/\/$/, "") + "/storage/v1/bucket/", {
        method: "GET",
        headers: { apikey: key, Authorization: "Bearer " + key },
      });
      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        let detail = raw.slice(0, 240);
        try { const parsed = JSON.parse(raw); detail = String(parsed.message || parsed.error || parsed.msg || detail).slice(0, 240); } catch {}
        console.error("Supabase bucket list failed", response.status, detail);
        return res.status(502).json({ ok: false, configured: true, bucket, storage_status: response.status, storage_error: detail, error: "Supabase responded, but the server could not list storage buckets. Check the project URL and service-role key." });
      }
      let buckets: Array<{ id?: string; name?: string }> = [];
      try { const parsed = JSON.parse(raw); buckets = Array.isArray(parsed) ? parsed : []; }
      catch { return res.status(502).json({ ok: false, configured: true, bucket, error: "Supabase returned an unexpected response while listing storage buckets." }); }
      const found = buckets.some(item => item.id === bucket || item.name === bucket);
      if (!found) return res.status(502).json({ ok: false, configured: true, bucket, storage_status: response.status, visible_bucket_count: buckets.length, error: "Supabase accepted the server credentials, but this project returned no bucket with the configured name." });
      return res.status(200).json({ ok: true, configured: true, bucket, storage: "reachable" });
    } catch (error) {
      console.error("Supabase connection check failed", error);
      return res.status(502).json({ ok: false, configured: true, error: "Could not reach Supabase from the server." });
    }
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  res.setHeader("Cache-Control", "no-store");
  if (!await requireAdmin(req, res)) return;
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