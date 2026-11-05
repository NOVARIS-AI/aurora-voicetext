export function shouldTryNextTranscriptionProvider(status) {
  // These failures describe the uploaded media itself, so another provider
  // cannot fix them. Provider auth, model, quota and transient errors can vary.
  return status !== 413 && status !== 415;
}
