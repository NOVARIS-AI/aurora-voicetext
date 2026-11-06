import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supabaseAdminHeaders, supabaseRestUrl } from "./_lib/admin-auth.js";

const clean = (value: unknown, max = 180) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const headers = supabaseAdminHeaders();
  if (!headers || !process.env.SUPABASE_URL) return res.status(503).json({ error: "Diagnostics storage is not configured." });
  const body = req.body || {};
  const installId = clean(body.installId, 80);
  const eventType = clean(body.eventType, 60);
  if (!installId || !/^[a-zA-Z0-9_-]+$/.test(installId) || !eventType) return res.status(400).json({ error: "Invalid diagnostic event." });
  const platform = clean(body.platform, 40) || "web";
  const version = clean(body.appVersion, 40) || "unknown";
  const feature = clean(body.feature, 80) || "app";
  const severity = ["info", "warning", "error"].includes(body.severity) ? body.severity : "info";
  const message = clean(body.message, 240);
  try {
    const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "") + "/rest/v1/";
    const upsert = await fetch(base + "vt_installations?on_conflict=install_id", { method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ install_id: installId, platform, app_version: version, last_seen_at: new Date().toISOString() }) });
    if (!upsert.ok) throw new Error("installation write failed");
    const event = await fetch(base + "vt_diagnostic_events", { method: "POST", headers, body: JSON.stringify({ install_id: installId, event_type: eventType, feature, severity, message: message || null, app_version: version, platform }) });
    if (!event.ok) throw new Error("event write failed");
    return res.status(202).json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Diagnostics could not be saved." });
  }
}
