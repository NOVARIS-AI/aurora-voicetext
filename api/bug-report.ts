import type { VercelRequest, VercelResponse } from "@vercel/node";
import { supabaseAdminHeaders } from "./_lib/admin-auth.js";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed." }); }
  const headers = supabaseAdminHeaders();
  if (!headers || !process.env.SUPABASE_URL) return res.status(503).json({ error: "Bug reporting is temporarily unavailable." });
  const body = req.body || {};
  const installId = clean(body.installId, 80);
  const description = clean(body.description, 2000);
  if (!installId || !/^[a-zA-Z0-9_-]+$/.test(installId) || description.length < 4) return res.status(400).json({ error: "Please describe the issue before submitting." });
  try {
    const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "") + "/rest/v1/vt_bug_reports";
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ install_id: installId, description, app_version: clean(body.appVersion, 40), platform: clean(body.platform, 40), page: clean(body.page, 50), status: "open" }) });
    if (!response.ok) throw new Error("write failed");
    return res.status(201).json({ ok: true, message: "Bug report received. Thank you." });
  } catch {
    return res.status(503).json({ error: "Could not submit the report. Please try again later." });
  }
}
