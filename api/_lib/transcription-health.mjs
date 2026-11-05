export function getTranscriptionProviderStatus(env = {}) {
  return {
    assemblyai: Boolean(env.ASSEMBLYAI_API_KEY),
    groq: Boolean(env.GROQ_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
  };
}

export function getTranscriptionHealth(env = {}) {
  const providers = getTranscriptionProviderStatus(env);
  const configured = Object.values(providers).some(Boolean);
  return {
    service: "aurora-voicetext-transcription",
    status: configured ? "ready" : "needs-configuration",
    onlineTranscriptionAvailable: configured,
    providers,
    checkedAt: new Date().toISOString(),
  };
}
