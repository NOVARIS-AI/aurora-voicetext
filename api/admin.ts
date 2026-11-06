import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAdmin, supabaseAdminHeaders, supabaseRestUrl } from "./_lib/admin-auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ error: "Method not allowed." }); }
  if (!await requireAdmin(req, res)) return;
  const headers = supabaseAdminHeaders();
  if (!headers || !process.env.SUPABASE_URL) return res.status(503).json({ error: "Admin diagnostics storage is not configured." });
  try {
    const [usersResponse, eventsResponse, reportsResponse] = await Promise.all([
      fetch(supabaseRestUrl("vt_installations") + "?select=install_id,platform,app_version,first_seen_at,last_seen_at&order=last_seen_at.desc&limit=500", { headers }),
      fetch(supabaseRestUrl("vt_diagnostic_events") + "?select=id,install_id,event_type,feature,severity,message,app_version,platform,created_at&order=created_at.desc&limit=500", { headers }),
      fetch(supabaseRestUrl("vt_bug_reports") + "?select=id,install_id,description,app_version,platform,page,status,created_at&order=created_at.desc&limit=300", { headers }),
    ]);
    if (!usersResponse.ok || !eventsResponse.ok || !reportsResponse.ok) throw new Error("Diagnostics tables unavailable.");
    const [users, events, reports] = await Promise.all([usersResponse.json(), eventsResponse.json(), reportsResponse.json()]);
    return res.status(200).json({ users, events, reports, checkedAt: new Date().toISOString() });
  } catch {
    return res.status(503).json({ error: "Could not load diagnostics. Apply the AURORA VoiceText diagnostics SQL migration in Supabase, then retry." });
  }
}
