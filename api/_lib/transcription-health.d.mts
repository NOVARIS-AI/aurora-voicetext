export type TranscriptionProviderStatus = {
  assemblyai: boolean;
  groq: boolean;
  openai: boolean;
};
export type TranscriptionHealth = {
  service: "aurora-voicetext-transcription";
  status: "ready" | "needs-configuration";
  onlineTranscriptionAvailable: boolean;
  providers: TranscriptionProviderStatus;
  checkedAt: string;
};
export function getTranscriptionProviderStatus(env?: Record<string, string | undefined>): TranscriptionProviderStatus;
export function getTranscriptionHealth(env?: Record<string, string | undefined>): TranscriptionHealth;
