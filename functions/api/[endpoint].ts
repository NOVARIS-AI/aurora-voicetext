interface Env {
  BACKUP_API_BASE_URL?: string;
  BACKUP_API_TOKEN?: string;
}

const ALLOWED_ENDPOINTS = new Set([
  "transcribe",
  "tts",
  "assist",
  "translate",
  "voice-chat",
  "subtitles",
  "subtitles-download",
  "health",
  "admin",
  "bug-report",
  "diagnostics",
  "aurora-transcribe",
]);
const VERCEL_API_ENDPOINTS = new Set([
  // Vercel remains primary for the other API routes. Document assistance
  // uses the Worker directly so its model fallback is available immediately.
  "transcribe",
  "tts",
  "translate",
  "voice-chat",
  "admin",
  "bug-report",
  "diagnostics",
  "aurora-transcribe",
]);
const VERCEL_API_BASE_URL = "https://aurora-voicetext-qk8s.vercel.app";

const corsHeaders = (origin: string): Headers => {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Vary": "Origin",
  });
  if (
    origin === "https://localhost" ||
    origin === "http://localhost" ||
    origin === "capacitor://localhost"
  ) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const endpoint = String(params.endpoint || "");
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return Response.json({ error: "API endpoint not found." }, { status: 404, headers });
  }

  const isHealth = endpoint === "health";
  const isVercelEndpoint = VERCEL_API_ENDPOINTS.has(endpoint);
  const isGetOnly = isHealth || endpoint === "admin";
  const allowsGetAndPost = endpoint === "aurora-transcribe";
  if (isGetOnly && request.method !== "GET") {
    headers.set("Allow", "GET");
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }
  if (allowsGetAndPost && !["GET", "POST"].includes(request.method)) {
    headers.set("Allow", "GET, POST");
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }
  if (!isGetOnly && !allowsGetAndPost && request.method !== "POST") {
    headers.set("Allow", "POST");
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }

  const configuredBaseUrl = env.BACKUP_API_BASE_URL || "https://aurora-voicetext-backup.schoolershubit5.workers.dev";
  const baseUrl = configuredBaseUrl.endsWith("/") ? configuredBaseUrl.slice(0, -1) : configuredBaseUrl;
  const token = env.BACKUP_API_TOKEN;
  if (!isVercelEndpoint && !token) {
    return Response.json(
      { error: "The AURORA backend connection is not configured on Cloudflare Pages." },
      { status: 503, headers },
    );
  }

  const workerPath = isHealth ? "/health" : "/api/" + endpoint;
  const target = isVercelEndpoint
    ? new URL(workerPath, VERCEL_API_BASE_URL)
    : new URL(workerPath, baseUrl);
  target.search = new URL(request.url).search;
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete("host");
  forwardedHeaders.delete("content-length");
  if (!isVercelEndpoint) forwardedHeaders.set("Authorization", "Bearer " + token);
  forwardedHeaders.set("Accept", request.headers.get("Accept") || "application/json, audio/mpeg, application/octet-stream");

  // Only these user-facing endpoints exist on the backup Worker. Admin,
  // diagnostics, bug reports and resumable-job polling stay on their primary.
  const workerFallbackEndpoints = new Set(["transcribe", "tts", "translate", "voice-chat"]);
  const canFallback = isVercelEndpoint && workerFallbackEndpoints.has(endpoint) && request.method === "POST";
  const workerToken = env.BACKUP_API_TOKEN;
  const fallbackRequest = canFallback && workerToken ? request.clone() : null;

  const makeResponse = (upstream: Response) => {
    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of headers) responseHeaders.set(key, value);
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.delete("Set-Cookie");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  };

  const callWorkerFallback = async (clone: Request): Promise<Response> => {
    const fallbackHeaders = new Headers(clone.headers);
    fallbackHeaders.delete("host");
    fallbackHeaders.delete("content-length");
    fallbackHeaders.set("Authorization", "Bearer " + workerToken);
    fallbackHeaders.set("Accept", request.headers.get("Accept") || "application/json, audio/mpeg, application/octet-stream");
    const fallbackUrl = new URL("/api/" + endpoint, baseUrl);
    fallbackUrl.search = new URL(request.url).search;
    return fetch(fallbackUrl.toString(), {
      method: "POST",
      headers: fallbackHeaders,
      body: clone.body,
      redirect: "manual",
      signal: AbortSignal.timeout(110000),
    });
  };

  try {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(110000),
    });

    if (canFallback && workerToken && upstream.status >= 500 && fallbackRequest) {
      try {
        return makeResponse(await callWorkerFallback(fallbackRequest));
      } catch {
        // Preserve the primary error response if the backup is also unavailable.
      }
    }
    return makeResponse(upstream);
  } catch {
    if (canFallback && workerToken && fallbackRequest) {
      try {
        return makeResponse(await callWorkerFallback(fallbackRequest));
      } catch {
        // Both upstreams failed; return a stable gateway error below.
      }
    }
    return Response.json(
      { error: "AURORA's primary and backup services could not be reached. Please try again shortly." },
      { status: 502, headers },
    );
  }
};
