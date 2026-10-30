import { ai } from '@appdeploy/sdk';
import { router, json, error } from '@appdeploy/sdk';

type TranscribeBody = {
  audioBase64?: string;
  mimeType?: string;
  chunkNumber?: number;
  totalChunks?: number;
  languageHint?: string;
};

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'POST /api/transcribe': [
    async ({ body }) => {
      const input = body as TranscribeBody;
      if (!input || typeof input.audioBase64 !== 'string' || !input.audioBase64.length) {
        return error('Audio chunk is missing.', 400);
      }
      if (input.audioBase64.length > 1800000) {
        return error('This audio chunk is too large. Please try again with a shorter audio segment.', 413);
      }
      const mimeType = input.mimeType || 'audio/wav';
      if (!mimeType.startsWith('audio/')) {
        return error('Unsupported audio format.', 400);
      }

      try {
        const result = await ai.ocr({
          prompt: 'Transcribe the supplied audio accurately. The speakers may mix Nigerian Pidgin English and standard English. Preserve the words and language actually spoken; do not translate Pidgin into standard English, do not summarise, and do not invent unclear words. Use readable punctuation. Return only the transcript.',
          system: 'You are a careful speech transcription engine. Preserve Nigerian Pidgin and English code-switching faithfully.',
          audios: [{ data: input.audioBase64, mimeType }],
          maxTokens: 4096,
          temperature: 0.1
        });
        if (!result.text?.trim()) return error('The transcription engine returned no text for this audio part.', 502);
        return json({
          text: result.text.trim(),
          chunkNumber: input.chunkNumber ?? 1,
          totalChunks: input.totalChunks ?? 1
        });
      } catch (err) {
        console.error('VoiceText transcription failed', err);
        const detail = err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message || '')
          : '';
        return error(detail ? `Transcription service error: ${detail.slice(0, 220)}` : 'The transcription service could not process this audio part. Check your connection and try again.', 502);
      }
    }
  ]
});