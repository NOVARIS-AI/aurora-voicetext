interface Env {
  BACKUP_API_BASE_URL?: string;
  BACKUP_API_TOKEN?: string;
}

const allowedOrigins = new Set([
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
]);

function responseHeaders(origin: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const origin = request.headers.get("Origin") || "";
  const headers = responseHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "GET") {
    headers.set("Allow", "GET");
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }

  const token = env.BACKUP_API_TOKEN;
  if (!token) {
    return Response.json(
      { app: "AURORA VoiceText", status: "degraded", error: "Backend connection is not configured." },
      { status: 503, headers },
    );
  }

  const baseUrl = (env.BACKUP_API_BASE_URL ||
    "https://aurora-voicetext-backup.alwerioghenepeace563.workers.dev").replace(/\/+$/, "");

  try {
    const target = new URL("/health", baseUrl);
    const upstream = await fetch(target, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    headers.set("Content-Type", contentType);
    headers.set("X-AURORA-Health-Source", "cloudflare-worker");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return Response.json(
      { app: "AURORA VoiceText", status: "unavailable", error: "Backup health service could not be reached." },
      { status: 502, headers },
    );
  }
};
