import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || 'voicetext-recordings';

  if (!url || !key) {
    return res.status(503).json({ ok: false, configured: false, error: 'Supabase server environment variables are missing.' });
  }

  try {
    const response = await fetch(url.replace(/\/$/, '') + '/storage/v1/bucket/' + encodeURIComponent(bucket), {
      method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('Supabase bucket check failed', response.status, detail.slice(0, 300));
      return res.status(502).json({
        ok: false,
        configured: true,
        bucket: bucket,
        error: response.status === 404
          ? 'Supabase is reachable, but the configured private recording bucket was not found.'
          : 'Supabase could not verify the recording bucket. Check the project URL, server key, and bucket permissions.',
      });
    }
    return res.status(200).json({ ok: true, configured: true, bucket: bucket, storage: 'reachable' });
  } catch (error) {
    console.error('Supabase connection check failed', error);
    return res.status(502).json({ ok: false, configured: true, error: 'Could not reach Supabase from the server.' });
  }
}
