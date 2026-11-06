import { useEffect, useRef, useState } from "react";
import { ShieldCheck, RefreshCw, LogOut, Users, Activity, Bug, AlertTriangle } from "lucide-react";

declare global { interface Window { google?: any; } }
type AdminData = { users: any[]; events: any[]; reports: any[]; checkedAt?: string };
export default function AdminPanel() {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [credential, setCredential] = useState("");
  const [data, setData] = useState<AdminData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const clientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || "";
  async function load(token: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin", { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Admin access could not be verified.");
      setCredential(token); setData(body);
    } catch (reason) { setCredential(""); setData(null); setError(reason instanceof Error ? reason.message : "Could not load admin dashboard."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!clientId || !buttonRef.current) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !window.google?.accounts?.id || !buttonRef.current) return;
      window.google.accounts.id.initialize({ client_id: clientId, callback: (result: { credential?: string }) => { if (result.credential) void load(result.credential); } });
      buttonRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(buttonRef.current, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 260 });
    };
    if (window.google?.accounts?.id) render();
    else {
      let script = document.querySelector<HTMLScriptElement>('script[data-aurora-google="1"]');
      if (!script) { script = document.createElement("script"); script.src = "https://accounts.google.com/gsi/client"; script.async = true; script.defer = true; script.dataset.auroraGoogle = "1"; document.head.appendChild(script); }
      script.addEventListener("load", render);
      return () => { cancelled = true; script?.removeEventListener("load", render); };
    }
    return () => { cancelled = true; };
  }, [clientId]);
  async function refresh() { if (credential) await load(credential); }
  const openReports = data?.reports.filter((report: any) => report.status === "open") || [];
  const errors = data?.events.filter((event: any) => event.severity === "error") || [];
  return <section className="page-content">
    <div className="page-heading"><div className="eyebrow"><ShieldCheck size={14}/> RESTRICTED CONSOLE</div><h1>Admin diagnostics</h1><p>Live operational view across registered app installations. User audio and transcript contents are never collected.</p></div>
    {!data ? <section className="card settings-card"><h2>Administrator sign-in</h2><p>Only the authorised Google account can open this dashboard.</p>{!clientId && <p role="alert">Google sign-in is not configured. Add VITE_GOOGLE_CLIENT_ID to the app build and GOOGLE_CLIENT_ID to the server environment using the same OAuth web client ID.</p>}<div ref={buttonRef}/>{busy && <p>Verifying administrator access…</p>}{error && <p role="alert">{error}</p>}</section> :
    <>
      <div className="quick-stats"><div><strong>{data.users.length}</strong><span>Installations</span></div><div><strong>{errors.length}</strong><span>Error events</span></div><div><strong>{openReports.length}</strong><span>Open reports</span></div></div>
      <div className="studio-actions"><button className="secondary small-button" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={15}/> Refresh diagnostics</button><button className="secondary small-button" onClick={()=>{setCredential("");setData(null);}}><LogOut size={15}/> Sign out</button></div>
      <section className="card settings-card"><h2><Activity size={17}/> System health</h2><div className="setting-row"><div><strong>Transcription</strong><p>{data.health?.transcriptionHealth?.onlineTranscriptionAvailable ? "Online providers available" : "No online provider available"}</p></div></div><div className="setting-row"><div><strong>Independent backup</strong><p>{data.health?.backupHealth?.status || "Unknown"}</p></div></div></section>
      <section className="card settings-card"><h2><Users size={17}/> App installations</h2>{data.users.length ? data.users.map((user:any)=><div className="setting-row" key={user.install_id}><div><strong>{user.platform} · {user.app_version}</strong><p>{user.install_id}</p><small>Last seen {new Date(user.last_seen_at).toLocaleString()}</small></div></div>) : <p>No installations reported yet.</p>}</section>
      <section className="card settings-card"><h2><Activity size={17}/> Recent diagnostic events</h2>{data.events.length ? data.events.slice(0,100).map((event:any)=><div className="setting-row" key={event.id}><div><strong>{event.severity.toUpperCase()} · {event.feature} · {event.event_type}</strong><p>{event.message || "No additional detail"}</p><small>{event.platform} · {event.app_version} · {new Date(event.created_at).toLocaleString()}</small></div></div>) : <p>No events recorded yet.</p>}</section>
      <section className="card settings-card"><h2><Bug size={17}/> User bug reports</h2>{data.reports.length ? data.reports.map((report:any)=><div className="setting-row" key={report.id}><div><strong>{report.status.toUpperCase()} · {report.page || "Unknown page"}</strong><p>{report.description}</p><small>{report.platform} · {report.app_version} · {new Date(report.created_at).toLocaleString()}</small></div></div>) : <p>No bug reports submitted yet.</p>}</section>
      <small>Updated {data.checkedAt ? new Date(data.checkedAt).toLocaleString() : "just now"}</small>
    </>}
  </section>;
}
