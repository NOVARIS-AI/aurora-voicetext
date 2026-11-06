export type BackupHealth = {
  configured: boolean;
  status: "not-configured" | "invalid-configuration" | "unavailable" | "degraded" | "ok";
  httpStatus?: number;
  service?: string;
  providers?: {
    transcription: boolean;
    speech: boolean;
    translation: boolean;
    transcriptPolish: boolean;
    subtitles: boolean;
    subtitleDownload: boolean;
  };
};
export function getBackupHealth(
  env?: Record<string, string | undefined>,
  fetcher?: typeof fetch
): Promise<BackupHealth>;
