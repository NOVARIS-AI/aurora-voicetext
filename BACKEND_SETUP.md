# AURORA VoiceText backend architecture

## Request flow

The Android app and web app call same-origin `/api/*` routes. They never receive provider credentials.

1. The primary API runs on Vercel and reads runtime environment variables.
2. Provider adapters try configured providers in order (Groq/OpenAI for transcription and translation; OpenAI/ElevenLabs for speech; OpenSubtitles for subtitle search).
3. If the primary provider chain fails, the API calls the independent Cloudflare Worker using `BACKUP_BACKEND_URL` and `BACKUP_BACKEND_TOKEN`.
4. The Worker has its own provider secrets and can continue operating if the Vercel project is unavailable, provided the app has the Worker URL configured as its API base or a separate client fallback is enabled in a future client update.

## Vercel runtime environment variables

Set these in Vercel Project Settings → Environment Variables. Do not prefix secrets with `VITE_`.

- `GROQ_API_KEY` — transcription and translation provider.
- `OPENAI_API_KEY` — transcription, translation and AI speech provider.
- `ELEVENLABS_API_KEY` — optional AI speech fallback.
- `OPENSUBTITLES_API_KEY` — subtitle search.
- `OPENSUBTITLES_TOKEN` — optional account authorization token for direct subtitle file downloads.
- `OPENSUBTITLES_USER_AGENT` — optional registered application user-agent.
- `BACKUP_BACKEND_URL` — deployed Cloudflare Worker base URL.
- `BACKUP_BACKEND_TOKEN` — shared bearer token; must match Worker `BACKUP_API_TOKEN`.

Optional model overrides: `GROQ_TRANSCRIPTION_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_TTS_MODEL`, `ELEVENLABS_TTS_MODEL`, `OPENAI_TRANSLATION_MODEL`, `GROQ_TRANSLATION_MODEL`.

## GitHub Actions secrets for the independent Worker

Repository → Settings → Secrets and variables → Actions → New repository secret:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BACKUP_API_TOKEN` (same value as Vercel `BACKUP_BACKEND_TOKEN`)
- `GROQ_API_KEY`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `OPENSUBTITLES_API_KEY`
- `OPENSUBTITLES_TOKEN`
- `OPENSUBTITLES_USER_AGENT`

The deploy workflow transfers the provider secrets to Cloudflare Worker secrets during deployment. GitHub Actions secrets are not automatically available to Vercel runtime functions: configure the Vercel variables separately.

## Deploy

After the GitHub Actions secrets are added, push a change under `backup-worker/` or run the **Deploy AURORA VoiceText backup worker** workflow manually. The workflow deliberately skips deployment when Cloudflare credentials are absent.

## Important limits

- No real provider keys are committed in this repository.
- Health checks expose only configured/not-configured booleans, never credentials.
- Subtitle search returns provider metadata and file identifiers. Direct file download requires the provider-issued OPENSUBTITLES_TOKEN in addition to the API key.
- The Worker is an independent backend, but the current Android app still uses its configured primary API base URL. A client-side direct-to-Worker failover needs a separate app change and must send the backup bearer token securely; do not embed that token in the APK.
- AI TTS requires a configured paid/available provider account. Browser speech synthesis is not represented as AI generation.
