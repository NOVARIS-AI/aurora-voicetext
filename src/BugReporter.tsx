import { useEffect, useState } from "react";
import { Bug, X, Send, ShieldCheck } from "lucide-react";

function installationId() {
  const key = "aurora-voicetext-install-id";
  try { let value = localStorage.getItem(key); if (!value) { value = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "avt-" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(key, value); } return value; }
  catch { return "session-" + Math.random().toString(36).slice(2); }
}
const installId = installationId();
const platform = /Android/i.test(navigator.userAgent) ? "Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iOS" : "Web";
const appVersion = (import.meta.env.VITE_APP_VERSION as string | undefined) || "1.0";
function sendDiagnostic(eventType: string, severity = "info", feature = "app", message = "", apiBaseUrl = "") {
  void fetch(apiBaseUrl + "/api/diagnostics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ installId, eventType, severity, feature, message, platform, appVersion }), keepalive: true }).catch(()=>{});
}
export default function BugReporter({ page, apiBaseUrl = "" }: { page: string; apiBaseUrl?: string }) {
  const [open,setOpen]=useState(false), [description,setDescription]=useState(""), [busy,setBusy]=useState(false), [status,setStatus]=useState("");
  useEffect(()=>{
    sendDiagnostic("app_opened", "info", "app", "", apiBaseUrl);
    const onError=()=>sendDiagnostic("runtime_error","error","runtime","A browser runtime error occurred.",apiBaseUrl);
    const onRejection=()=>sendDiagnostic("unhandled_rejection","error","runtime","An unhandled asynchronous error occurred.",apiBaseUrl);
    window.addEventListener("error",onError); window.addEventListener("unhandledrejection",onRejection);
    let lastShake=0;
    const onMotion=(event:DeviceMotionEvent)=>{
      const a=event.accelerationIncludingGravity; if(!a) return;
      const strength=Math.sqrt((a.x||0)**2+(a.y||0)**2+(a.z||0)**2);
      if(strength>25 && Date.now()-lastShake>1800){lastShake=Date.now();setOpen(true);setStatus("");}
    };
    window.addEventListener("devicemotion",onMotion);
    return ()=>{window.removeEventListener("error",onError);window.removeEventListener("unhandledrejection",onRejection);window.removeEventListener("devicemotion",onMotion);};
  },[apiBaseUrl]);
  async function submit(){
    if(description.trim().length<4){setStatus("Please describe what happened.");return;}
    setBusy(true);setStatus("");
    try{const response=await fetch(apiBaseUrl + "/api/bug-report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({installId,description:description.trim(),platform,appVersion,page})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||"Could not submit report.");setStatus(body.message||"Report received.");setDescription("");}
    catch(reason){setStatus(reason instanceof Error?reason.message:"Could not submit report.");}
    finally{setBusy(false);}
  }
  return <>
    <button type="button" className="bug-report-trigger" onClick={()=>setOpen(true)} aria-label="Report a bug"><Bug size={16}/><span>Report a bug</span></button>
    {open&&<div className="bug-report-backdrop" role="presentation"><section className="bug-report-dialog" role="dialog" aria-modal="true" aria-labelledby="bug-report-title"><button className="bug-report-close" onClick={()=>setOpen(false)} aria-label="Close report" type="button"><X size={18}/></button><div className="eyebrow"><Bug size={14}/> APP FEEDBACK</div><h2 id="bug-report-title">Report a problem</h2><p>Tell us what went wrong. We’ll attach basic app and device diagnostics, not your recordings or transcript text.</p><textarea value={description} onChange={e=>setDescription(e.target.value)} rows={5} maxLength={2000} placeholder="Describe what happened…"/><small>{description.length}/2000 characters</small><div className="studio-actions"><button className="primary" type="button" onClick={()=>void submit()} disabled={busy}><Send size={15}/>{busy?"Sending…":"Send report"}</button><button className="secondary" type="button" onClick={()=>setOpen(false)}>Close</button></div>{status&&<p role="status">{status}</p>}<small><ShieldCheck size={13}/> Shake your phone to open this report.</small></section></div>}
  </>;
}
