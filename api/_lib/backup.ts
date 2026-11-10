type BackupPath = "/api/transcribe" | "/api/tts" | "/api/assist" | "/api/translate" | "/api/subtitles" | "/api/subtitles-download" | "/api/voice-chat";
export async function callBackup(path: BackupPath, body: unknown): Promise<Response | null> {
  const base = process.env.BACKUP_BACKEND_URL?.replace(/\/+$/, "");
  const token = process.env.BACKUP_BACKEND_TOKEN;
  if (!base || !token) return null;
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(115000),
  });
}
