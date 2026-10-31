import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_RECORDINGS_BUCKET || 'voicetext-recordings';

  if (!url || !key) {
    return res.status(503).json({ ok: false, configured: false, error: 'Supabase server environment variables are missing.' });
  }

  try {
    // List buckets and match by ID to give a clearer diagnosis than a single-bucket lookup.
    const response = await fetch(url.replace(/\/$/, '') + '/storage/v1/bucket', {
      method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    const raw = await response.text().catch(() => '');

    if (!response.ok) {
      let detail = raw.slice(0, 240);
      try {
        const parsed = JSON.parse(raw);
        detail = String(parsed.message || parsed.error || parsed.msg || detail).slice(0, 240);
      } catch {
        // Keep bounded response text for diagnosis.
      }
      console.error('Supabase bucket list failed', response.status, detail);
      return res.status(502).json({
        ok: false,
        configured: true,
        bucket,
        storage_status: response.status,
        storage_error: detail || 'Supabase rejected the bucket-list request.',
        error: 'Supabase responded, but the server could not list storage buckets. Check the project URL and service-role key.',
      });
    }

    let buckets: Array<{ id?: string; name?: string }> = [];
    try {
      const parsed = JSON.parse(raw);
      buckets = Array.isArray(parsed) ? parsed : [];
    } catch {
      return res.status(502).json({
        ok: false,
        configured: true,
        bucket,
        error: 'Supabase returned an unexpected response while listing storage buckets.',
      });
    }

    const found = buckets.some((item) => item.id === bucket || item.name === bucket);
    if (!found) {
      return res.status(502).json({
        ok: false,
        configured: true,
        bucket,
        storage_status: response.status,
        visible_bucket_count: buckets.length,
        error: 'Supabase accepted the server credentials, but this project returned no bucket with the configured name.',
      });
    }

    return res.status(200).json({ ok: true, configured: true, bucket, storage: 'reachable' });
  } catch (error) {
    console.error('Supabase connection check failed', error);
    return res.status(502).json({ ok: false, configured: true, error: 'Could not reach Supabase from the server.' });
  }
}
