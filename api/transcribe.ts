import type { VercelRequest, VercelResponse } from '@vercel/node';

type TranscribeBody = {
  audioBase64?: string;
  mimeType?: string;
  chunkNumber?: number;
  totalChunks?: number;
  languageHint?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const allowedOrigins = new Set([
    'https://localhost',
    'http://localhost',
    'capacitor://localhost',
    'https://aurora-voicetext-qk8s.vercel.app',
    'https://aurora-voicetext.vercel.app',
  ]);
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const input = (req.body || {}) as TranscribeBody;
  if (typeof input.audioBase64 !== 'string' || !input.audioBase64.length) {
    return res.status(400).json({ error: 'Audio chunk is missing.' });
  }
  if (input.audioBase64.length > 1800000) {
    return res.status(413).json({ error: 'This audio chunk is too large. Please try again with a shorter audio segment.' });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.audioBase64) || input.audioBase64.length % 4 !== 0) {
    return res.status(400).json({ error: 'The audio upload is not valid base64 data. Please retry this section.' });
  }
  const mimeType = input.mimeType || 'audio/wav';
  const supportedTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm']);
  if (!supportedTypes.has(mimeType.toLowerCase())) return res.status(400).json({ error: 'Unsupported audio format: ' + mimeType });
  if (input.chunkNumber !== undefined && (!Number.isInteger(input.chunkNumber) || input.chunkNumber < 1)) return res.status(400).json({ error: 'Invalid audio section number.' });
  if (input.totalChunks !== undefined && (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > 2000)) return res.status(400).json({ error: 'Invalid total audio section count.' });
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Online transcription is not configured yet. Add GROQ_API_KEY to Vercel Environment Variables.' });

  try {
    const audioBytes = Buffer.from(input.audioBase64, 'base64');
    const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
    new Uint8Array(audioBuffer).set(audioBytes);
    const form = new FormData();
    const normalizedMime = mimeType.toLowerCase();
    const extension = normalizedMime === 'audio/mpeg' || normalizedMime === 'audio/mp3' ? 'mp3'
      : normalizedMime === 'audio/ogg' ? 'ogg'
      : normalizedMime === 'audio/mp4' ? 'm4a'
      : normalizedMime === 'audio/aac' ? 'aac'
      : normalizedMime === 'audio/webm' ? 'webm' : 'wav';
    form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio-chunk.' + extension);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    const languageHint = typeof input.languageHint === 'string' ? input.languageHint.replace(/[\\r\\n]/g, ' ').slice(0, 120) : 'English and Nigerian Pidgin';
    form.append('prompt', 'Transcribe accurately. Likely language context: ' + languageHint + '. Speakers may mix Nigerian Pidgin English and standard English. Preserve the words and language actually spoken; do not translate Pidgin, summarize, or invent unclear words. Return only the transcript.');

    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: form,
    });
    const result = await upstream.json().catch(() => ({})) as { text?: string; segments?: Array<{ start?: number; end?: number; text?: string }>; error?: { message?: string } | string };
    if (!upstream.ok) {
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter && (upstream.status === 429 || upstream.status >= 500)) {
        res.setHeader('Retry-After', retryAfter);
      }
      const detail = typeof result.error === 'string' ? result.error : result.error?.message;
      console.error('Groq transcription error', upstream.status, detail);
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        error: detail ? 'Transcription provider error: ' + detail.slice(0, 220) : 'The transcription provider could not process this audio part.',
      });
    }
    if (typeof result.text !== 'string' || !result.text.trim()) {
      return res.status(502).json({ error: 'The transcription engine returned no text for this audio part.' });
    }
    return res.status(200).json({ text: result.text.trim(), segments: Array.isArray(result.segments) ? result.segments.filter(segment => typeof segment.start === 'number' && typeof segment.end === 'number' && typeof segment.text === 'string') : [], chunkNumber: input.chunkNumber ?? 1, totalChunks: input.totalChunks ?? 1 });
  } catch (err) {
    console.error('VoiceText transcription failed', err);
    return res.status(502).json({ error: 'The transcription service could not process this audio part. Check your connection and try again.' });
  }
}
