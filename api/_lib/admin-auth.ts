import type { VercelRequest, VercelResponse } from "@vercel/node";

export const ADMIN_EMAIL = "alwerioghenepeace563@gmail.com";

export async function requireAdmin(req: VercelRequest, res: VercelResponse): Promise<boolean> {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) { res.status(401).json({ error: "Google sign-in is required." }); return false; }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) { res.status(503).json({ error: "Admin sign-in is not configured yet. Add GOOGLE_CLIENT_ID to the server environment." }); return false; }
  try {
    const response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(match[1]));
    if (!response.ok) throw new Error("Invalid Google credential.");
    const identity = await response.json() as { aud?: string; email?: string; email_verified?: string | boolean; exp?: string };
    if (identity.aud !== clientId || identity.email?.toLowerCase() !== ADMIN_EMAIL ||
        !(identity.email_verified === true || identity.email_verified === "true") ||
        !identity.exp || Number(identity.exp) * 1000 <= Date.now()) {
      res.status(403).json({ error: "This Google account is not authorised for Admin access." });
      return false;
    }
    return true;
  } catch {
    res.status(401).json({ error: "Google sign-in could not be verified. Please sign in again." });
    return false;
  }
}

export function supabaseAdminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key ? { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" } : null;
}
export function supabaseRestUrl(table: string) {
  return (process.env.SUPABASE_URL || "").replace(/\/$/, "") + "/rest/v1/" + table;
}
