import type { VercelRequest, VercelResponse } from "@vercel/node";
import { searchSubtitles, type SubtitleSearchRequest } from "./_lib/ai-providers";
import { callBackup } from "./_lib/backup";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  res.setHeader("Cache-Control", "no-store");
  const input = (req.body || {}) as SubtitleSearchRequest;
  if (typeof input.query !== "string" || input.query.trim().length < 2 || input.query.length > 180) return res.status(400).json({ error: "Enter a video title with 2–180 characters." });
  const normalized = { query: input.query.trim(), languages: (input.languages || "en").slice(0, 80), type: input.type === "episode" ? "episode" as const : input.type === "movie" ? "movie" as const : undefined };
  try { return res.status(200).json({ results: await searchSubtitles(normalized), provider: "opensubtitles" }); }
  catch (primaryError) {
    try {
      const backup = await callBackup("/api/subtitles", normalized);
      if (backup?.ok) return res.status(200).json(await backup.json());
    } catch (error) { console.error("Backup subtitle search failed", error); }
    const message = primaryError instanceof Error ? primaryError.message : "Subtitle search unavailable.";
    return res.status(503).json({ error: message.slice(0, 350), fallbackAttempted: true });
  }
}
