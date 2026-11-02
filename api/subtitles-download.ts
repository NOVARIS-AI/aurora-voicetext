import type { VercelRequest, VercelResponse } from "@vercel/node";
import { callBackup } from "./_lib/backup";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const fileId = Number((req.body || {}).fileId);
  if (!Number.isInteger(fileId) || fileId < 1) return res.status(400).json({ error: "A valid subtitle file ID is required." });
  if (!process.env.OPENSUBTITLES_API_KEY || !process.env.OPENSUBTITLES_TOKEN) {
    return res.status(503).json({ error: "Subtitle download requires OPENSUBTITLES_API_KEY and OPENSUBTITLES_TOKEN." });
  }
  try {
    const response = await fetch("https://api.opensubtitles.com/api/v1/download", {
      method: "POST",
      headers: { "Api-Key": process.env.OPENSUBTITLES_API_KEY, "User-Agent": process.env.OPENSUBTITLES_USER_AGENT || "AURORA-VoiceText/1.0", Authorization: "Bearer " + process.env.OPENSUBTITLES_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json().catch(() => ({})) as { link?: string; file_name?: string; message?: string };
    if (!response.ok || !payload.link) throw new Error(payload.message || "Subtitle provider did not authorize this download.");
    const file = await fetch(payload.link, { signal: AbortSignal.timeout(30000) });
    if (!file.ok) throw new Error("Could not retrieve the authorized subtitle file.");
    res.setHeader("Content-Type", file.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="' + (payload.file_name || "subtitle.srt").replace(/[^A-Za-z0-9._-]/g, "_") + '"');
    res.setHeader("X-AURORA-Provider", "opensubtitles");
    return res.status(200).send(Buffer.from(await file.arrayBuffer()));
  } catch (error) {
    try {
      const backup = await callBackup("/api/subtitles-download", { fileId });
      if (backup?.ok) {
        res.setHeader("Content-Type", backup.headers.get("content-type") || "application/octet-stream");
        res.setHeader("Content-Disposition", backup.headers.get("content-disposition") || 'attachment; filename="subtitle.srt"');
        res.setHeader("X-AURORA-Provider", "backup-opensubtitles");
        return res.status(200).send(Buffer.from(await backup.arrayBuffer()));
      }
    } catch (backupError) { console.error("Backup subtitle download failed", backupError); }
    return res.status(503).json({ error: error instanceof Error ? error.message.slice(0, 300) : "Subtitle download unavailable.", fallbackAttempted: true });
  }
}
