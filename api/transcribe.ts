import type { VercelRequest, VercelResponse } from '@vercel/node';

type TranscribeBody = {
  audioBase64?: string;
  mimeType?: string;
  chunkNumber?: number;
  totalChunks?: number;
  languageHint?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const input = (req.body || {}) as TranscribeBody;
  if (typeof input.audioBase64 !== 'string' || !input.audioBase64.length) {
    return res.status(400).json({ error: 'Audio chunk is missing.' });
  }
  if (input.audioBase64.length > 1800000) {
    return res.status(413).json({ error: 'This audio chunk is too large. Please try again with a shorter audio segment.' });
  }
  const mimeType = input.mimeType || 'audio/wav';
  if (!mimeType.startsWith('audio/')) return res.status(400).json({ error: 'Unsupported audio format.' });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Online transcription is not configured yet. Add GROQ_API_KEY to Vercel Environment Variables.' });

  try {
    const audioBytes = Buffer.from(input.audioBase64, 'base64');
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const form = new FormData();
    const extension = mimeType === 'audio/mpeg' ? 'mp3' : mimeType === 'audio/ogg' ? 'ogg' : 'wav';
    form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio-chunk.' + extension);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', 'Transcribe accurately. Speakers may mix Nigerian Pidgin English and standard English. Preserve the words and language actually spoken; do not translate Pidgin, summarize, or invent unclear words. Return only the transcript.');

    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
    });
    const result = await upstream.json().catch(() => ({})) as { text?: string; error?: { message?: string } | string };
    if (!upstream.ok) {
      const detail = typeof result.error === 'string' ? result.error : result.error?.message;
      console.error('Groq transcription error', upstream.status, detail);
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        error: detail ? 'Transcription provider error: ' + detail.slice(0, 220) : 'The transcription provider could not process this audio part.',
      });
    }
    if (typeof result.text !== 'string' || !result.text.trim()) {
      return res.status(502).json({ error: 'The transcription engine returned no text for this audio part.' });
    }
    return res.status(200).json({ text: result.text.trim(), chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
  } catch (err) {
    console.error('VoiceText transcription failed', err);
    return res.status(502).json({ error: 'The transcription service could not process this audio part. Check your connection and try again.' });
  }
}
