/**
 * Check the separately hosted backup Worker without exposing credentials.
 * The health endpoint is diagnostic only: a failed backup check must not
 * make a healthy primary transcription deployment appear completely down.
 */
export async function getBackupHealth(env = {}, fetcher = fetch) {
  const base = typeof env.BACKUP_BACKEND_URL === "string"
    ? env.BACKUP_BACKEND_URL.trim().replace(/\/+$/, "")
    : "";
  const token = typeof env.BACKUP_BACKEND_TOKEN === "string"
    ? env.BACKUP_BACKEND_TOKEN.trim()
    : "";

  if (!base || !token) {
    return { configured: false, status: "not-configured" };
  }

  let target;
  try {
    target = new URL("/health", base);
    if (target.protocol !== "https:" && target.hostname !== "localhost") {
      return { configured: true, status: "invalid-configuration" };
    }
  } catch {
    return { configured: true, status: "invalid-configuration" };
  }

  try {
    const response = await fetcher(target.toString(), {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });
    if (!response.ok) {
      return { configured: true, status: "unavailable", httpStatus: response.status };
    }

    const payload = await response.json().catch(() => null);
    if (!payload || payload.status !== "ok") {
      return { configured: true, status: "degraded" };
    }

    return {
      configured: true,
      status: "ok",
      service: typeof payload.service === "string" ? payload.service : "backup-worker",
      providers: payload.providers && typeof payload.providers === "object"
        ? {
            transcription: Boolean(payload.providers.transcription),
            speech: Boolean(payload.providers.speech),
            translation: Boolean(payload.providers.translation),
            transcriptPolish: Boolean(payload.providers.transcriptPolish),
            subtitles: Boolean(payload.providers.subtitles),
            subtitleDownload: Boolean(payload.providers.subtitleDownload),
          }
        : undefined,
    };
  } catch {
    return { configured: true, status: "unavailable" };
  }
}
