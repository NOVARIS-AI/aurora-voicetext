# AURORA VoiceText backend and failover

## Architecture

- The app calls same-origin `/api/*` endpoints. No provider secret is shipped to the browser or APK.
- The primary serverless API tries configured providers in order: Groq, then OpenAI.
- A provider timeout, rate limit, network failure, or server error triggers the next configured provider.
- If both primary providers fail, the API can forward the same request to the independent Cloudflare Worker.
- The Worker has its own provider credentials and repeats provider failover. It is protected by a shared bearer token.
- `GET /api/health` reports capability booleans only. It never returns key values.

## Runtime secrets

Configure these in the hosting provider's server-side environment settings (Production and Preview as appropriate):

- `GROQ_API_KEY` — primary transcription provider and optional AI text/chat provider.
- Groq text defaults use `openai/gpt-oss-20b` for translation, transcript cleanup and document assistance, and `openai/gpt-oss-120b` for voice chat. Retired Llama 3.1/3.3 model overrides are automatically mapped to their recommended replacements.
- `OPENAI_API_KEY` — secondary transcription provider and future AI features.
- `ELEVENLABS_API_KEY` — reserved for AI speech generation integration.
- `BACKUP_BACKEND_URL` — Cloudflare Worker origin, without a trailing slash.
- `BACKUP_BACKEND_TOKEN` — same value as the Worker `BACKUP_API_TOKEN`.

Do not use `VITE_*` names for secrets. Vite variables are public in built browser assets. Do not commit real keys to GitHub files, issues, logs, or APKs.

## Deploy the independent backup

1. Install Wrangler and authenticate to the Cloudflare account.
2. From `backup-worker/`, run `npx wrangler secret put BACKUP_API_TOKEN`.
3. Add provider secrets with `npx wrangler secret put GROQ_API_KEY` and/or `npx wrangler secret put OPENAI_API_KEY`.
4. Deploy with `npx wrangler deploy`.
5. Confirm `https://YOUR-WORKER.workers.dev/health` returns status ok.
6. Configure the primary host with `BACKUP_BACKEND_URL=https://YOUR-WORKER.workers.dev` and `BACKUP_BACKEND_TOKEN` matching the Worker token.

Use a long random token and keep it private. Rotate it if it is ever exposed.

## GitHub Secrets vs runtime secrets

GitHub Actions Secrets are available only to workflows that explicitly map them into a job's environment. They do not automatically become Vercel or Cloudflare runtime variables. Use GitHub Secrets for CI/deployment automation; use Vercel Project Environment Variables and Cloudflare Worker Secrets for live requests. Never put secrets in a workflow artifact or client build.

## Fallback behavior

Failover is attempted for provider network errors, timeouts, HTTP 408, 429, and 5xx. Most other 4xx responses indicate invalid requests and stop retrying. The app should preserve its existing local/offline transcription fallback when every server provider is unavailable.

## Current activation status

The code and configuration templates can be committed without credentials. Provider failover becomes active only after the runtime secrets and backup Worker are deployed. AI speech, translation, and subtitle discovery still need their own route/provider integrations; the keys above are reserved and must not be represented as working features until those integrations are implemented.

## GitHub Actions secrets for automated Worker deployment

In the repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `CLOUDFLARE_API_TOKEN` — token permitted to deploy Workers and manage Worker secrets.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account identifier.
- `BACKUP_API_TOKEN` — long random shared bearer token.
- `GROQ_API_KEY` — optional Worker primary transcription key.
- `OPENAI_API_KEY` — optional Worker secondary transcription key.

The `Deploy AURORA VoiceText backup worker` workflow deploys when `backup-worker/**` changes or when manually dispatched. If Cloudflare credentials are absent, it skips deployment and reports that configuration is needed.

Separately add `GROQ_API_KEY`, `OPENAI_API_KEY`, `BACKUP_BACKEND_URL`, and `BACKUP_BACKEND_TOKEN` to the primary API host's runtime environment. For this project that is the Vercel project environment settings. A GitHub secret does not automatically populate Vercel's runtime environment. Once Vercel quota is available, those runtime values must be configured there and a new deployment created for them to take effect.

## Direct app failover when the primary host is unreachable

The Android/web client now accepts a public backup URL through the build-time variable `VITE_BACKUP_API_BASE_URL`. Set the GitHub repository variable `BACKUP_API_BASE_URL` to the deployed Worker origin (for example, the Worker `workers.dev` origin, without a trailing slash). The APK workflow injects this public URL into the app; it is an endpoint, not a secret.

The Worker accepts direct app-origin requests only when its `BACKUP_PUBLIC_FALLBACK` Worker secret is exactly `true`. The allowed origins are the production web origins and Capacitor's localhost origins. For the automated deployment workflow, add a GitHub Actions secret named `BACKUP_PUBLIC_FALLBACK` with value `true`. Keep `BACKUP_API_TOKEN` configured too for authenticated server-to-server fallback from Vercel.

**Security note:** browser CORS origin checks are not authentication; non-browser clients can forge an Origin header. Before enabling public direct fallback, configure Cloudflare rate limiting and usage alerts for the Worker, monitor provider spend, and rotate keys if abused. Keep audio request size limits in place. If you do not want a public Worker endpoint, leave `BACKUP_PUBLIC_FALLBACK=false`; Vercel-to-Worker failover will still work while Vercel is reachable.

The client attempts the primary endpoint first and uses the configured Worker when the primary host cannot be reached or returns a retryable server/rate-limit response. No API key is embedded in the APK.
