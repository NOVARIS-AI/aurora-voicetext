# AURORA VoiceText backend architecture

## Request flow

The Android app and web app call same-origin `/api/*` routes. They never receive provider credentials.

1. The primary API runs on Vercel and reads runtime environment variables.
2. Provider adapters try configured providers in order (AssemblyAI first for online transcription when `ASSEMBLYAI_API_KEY` is set, then Groq/OpenAI; OpenAI/Groq for translation; OpenAI/ElevenLabs for speech; OpenSubtitles for subtitle search).
3. If the primary provider chain fails, the API calls the independent Cloudflare Worker using `BACKUP_BACKEND_URL` and `BACKUP_BACKEND_TOKEN`.
4. The Worker has its own provider secrets, including optional `ASSEMBLYAI_API_KEY` for language detection and speaker diarization. The app can use it as a direct secondary endpoint through the build-time `VITE_BACKUP_API_BASE_URL` setting when the primary host is unreachable or returns a retryable failure. Server-side Vercel functions can also call it using the private token.

## Vercel runtime environment variables

Set these in Vercel Project Settings → Environment Variables. Do not prefix secrets with `VITE_`.

- `ASSEMBLYAI_API_KEY` — optional online transcription provider with automatic language detection and speaker diarization. When configured, AssemblyAI is tried first; Groq/OpenAI remain fallbacks.
- `GROQ_API_KEY` — transcription and translation provider.
- `OPENAI_API_KEY` — transcription, translation and AI speech provider.
- `ELEVENLABS_API_KEY` — optional AI speech fallback.
- `ELEVENLABS_DEFAULT_VOICE_ID` — optional default ElevenLabs voice.
- `ELEVENLABS_VOICE_NOVA_ID`, `ELEVENLABS_VOICE_SHIMMER_ID`, `ELEVENLABS_VOICE_CORAL_ID`, `ELEVENLABS_VOICE_SAGE_ID`, `ELEVENLABS_VOICE_ONYX_ID`, `ELEVENLABS_VOICE_ECHO_ID`, `ELEVENLABS_VOICE_ASH_ID`, `ELEVENLABS_VOICE_FABLE_ID`, `ELEVENLABS_VOICE_ALLOY_ID` — optional individual voice IDs. Configure only voices available in your ElevenLabs account; otherwise the default voice is used.
- `OPENSUBTITLES_API_KEY` — subtitle search.
- `OPENSUBTITLES_TOKEN` — optional account authorization token for direct subtitle file downloads.
- `OPENSUBTITLES_USER_AGENT` — optional registered application user-agent.
- `OPENAI_TTS_MODEL`, `ELEVENLABS_TTS_MODEL`, `OPENAI_TRANSLATION_MODEL`, `GROQ_TRANSLATION_MODEL` — optional model overrides.
- `BACKUP_BACKEND_URL` — deployed Cloudflare Worker base URL.
- `BACKUP_BACKEND_TOKEN` — shared bearer token; must match Worker `BACKUP_API_TOKEN`.

Optional model overrides: `GROQ_TRANSCRIPTION_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_TTS_MODEL`, `ELEVENLABS_TTS_MODEL`, `OPENAI_TRANSLATION_MODEL`, `GROQ_TRANSLATION_MODEL`.

## GitHub Actions secrets for the independent Worker

Repository → Settings → Secrets and variables → Actions → New repository secret:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BACKUP_API_TOKEN` (same value as Vercel `BACKUP_BACKEND_TOKEN`)
- `ASSEMBLYAI_API_KEY` (optional; enables language detection and speaker diarization on both the Cloudflare Worker and primary online transcription service)
- `GROQ_API_KEY` and/or `OPENAI_API_KEY` (fallback transcription providers)
- `GROQ_API_KEY`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `OPENSUBTITLES_API_KEY`
- `OPENSUBTITLES_TOKEN`
- `OPENSUBTITLES_USER_AGENT`
- `ELEVENLABS_DEFAULT_VOICE_ID` (optional default voice when ElevenLabs is the speech provider).
- `ELEVENLABS_VOICE_NOVA_ID`, `ELEVENLABS_VOICE_SHIMMER_ID`, `ELEVENLABS_VOICE_CORAL_ID`, `ELEVENLABS_VOICE_SAGE_ID`, `ELEVENLABS_VOICE_ONYX_ID`, `ELEVENLABS_VOICE_ECHO_ID`, `ELEVENLABS_VOICE_ASH_ID`, `ELEVENLABS_VOICE_FABLE_ID`, `ELEVENLABS_VOICE_ALLOY_ID` (optional provider voice IDs; configure only the profiles you have access to to give the named Voice Studio choices distinct ElevenLabs voices).
- `BACKUP_PUBLIC_FALLBACK` (Worker secret; keep false/unset until Cloudflare rate limiting and spend alerts are configured)
- `BACKUP_API_PUBLIC_FALLBACK` (GitHub Actions repository variable; set to `true` only at the same time as the Worker public-fallback secret, after rate limiting is active. This controls whether the APK calls the Worker directly.)

The deploy workflow transfers the provider secrets to Cloudflare Worker secrets during deployment. GitHub Actions secrets are not automatically available to Vercel runtime functions: configure the Vercel variables separately.

## Deploy

After the GitHub Actions secrets are added, run **Deploy AURORA VoiceText backup worker** from Actions → Workflows → Run workflow, or merge a change under `backup-worker/` into `main`. The workflow deploys `backup-worker/` independently of Vercel. It skips deployment when Cloudflare credentials are absent. Add the deployed Worker origin (without a trailing slash) as the GitHub Actions repository variable `BACKUP_API_BASE_URL`; the APK build injects it as `VITE_BACKUP_API_BASE_URL`.

## Important limits

- No real provider keys are committed in this repository.
- Health checks expose only configured/not-configured booleans, never credentials.
- Subtitle search returns provider metadata and file identifiers. Direct file download requires the provider-issued OPENSUBTITLES_TOKEN in addition to the API key.
- The Android app uses the primary API first. The primary server proxies to the private Worker using `BACKUP_BACKEND_TOKEN`, so the APK never needs a private token. Direct Worker fallback is disabled in the APK by default; it is compiled in only when the GitHub Actions variable `BACKUP_API_PUBLIC_FALLBACK=true` is set and the Worker secret `BACKUP_PUBLIC_FALLBACK=true` is also enabled. Origin restrictions are not authentication, so configure Cloudflare rate limits and spend alerts before enabling either setting. Never embed the private backup bearer token in the APK.
- AI TTS requires a configured paid/available provider account. Browser speech synthesis is not represented as AI generation.


## Implemented application endpoints

- `POST /api/transcribe` — Groq/OpenAI transcription with backup failover.
- `POST /api/tts` — AI speech generation with OpenAI/ElevenLabs fallback.
- `POST /api/assist` — transcript cleanup that preserves the spoken meaning and language.
- `POST /api/translate` — AI translation while preserving subtitle structure.
- `POST /api/subtitles` and `POST /api/subtitles-download` — OpenSubtitles catalogue search and authorized file download.
- `GET /api/health` — provider configuration status without exposing keys.


## Multilingual transcription and speaker labels

When `ASSEMBLYAI_API_KEY` is configured on the Vercel project, online audio sections are uploaded to AssemblyAI with automatic language detection and speaker diarization enabled. The API returns utterances with timestamps and generic speaker labels, which AURORA displays in the timestamped preview. If AssemblyAI is not configured or does not support a particular audio section/language feature, the service falls back to Groq/OpenAI Whisper; those fallback providers may not return speaker labels. Language detection is most reliable with at least 15 seconds of spoken audio. Since long recordings are processed in separate sections to protect mobile memory, speaker labels are section-local and are not guaranteed to identify the same person consistently across different sections. Offline Whisper Tiny does not provide speaker diarization.

AssemblyAI usage is subject to its account limits and pricing. Configure the key as a server-side Vercel environment variable only; never put it in a `VITE_` variable, APK, or committed file.


## Cloudflare backend migration notes

The Cloudflare Worker now tries AssemblyAI first when its server-side `ASSEMBLYAI_API_KEY` secret is present. It enables automatic language detection and speaker diarization, returning `language`, timestamped `segments`, and `speaker` labels. If AssemblyAI fails or is not configured, the Worker falls back to Groq and then OpenAI Whisper. Speaker labels are scoped to each uploaded audio section and are not guaranteed to remain consistent across separate sections.

The Worker deployment workflow is `.github/workflows/backup-worker-deploy.yml` (the existing standalone Worker workflow). It requires GitHub Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `ASSEMBLYAI_API_KEY`; `GROQ_API_KEY`, `OPENAI_API_KEY`, and `BACKUP_API_TOKEN` are also used when configured. Never put provider keys in Vite variables or the Android APK.

For direct app fallback, set the GitHub Actions repository variable `BACKUP_API_BASE_URL` to `https://aurora-voicetext-backup.alwerioghenepeace563.workers.dev` so Android builds can inject `VITE_BACKUP_API_BASE_URL`. The Worker remains private by default: `BACKUP_PUBLIC_FALLBACK` must not be enabled until Cloudflare rate limiting and abuse controls are configured. Do not embed `BACKUP_API_TOKEN` in the APK.


## Cloudflare Pages website migration (production-safe)

The frontend migration is implemented as a Cloudflare Pages deployment while preserving the existing Vite/React source and the independent Worker.

### Architecture

- Cloudflare Pages serves the existing Vite build from `dist/`.
- `functions/api/[endpoint].ts` is a same-origin Pages Function proxy for the supported API routes.
- The Pages Function forwards requests to the verified Worker at `https://aurora-voicetext.alwerioghenepeace563.workers.dev` and attaches `BACKUP_API_TOKEN` server-side. The token is never placed in Vite variables, browser JavaScript, or the Android APK.
- `GET /api/health` is mapped to the Worker's `GET /health`; the existing POST feature paths are forwarded to their matching Worker routes.
- The proxy allows only the known AURORA API endpoint names and forwards binary responses as streams.
- Vercel remains unchanged during this migration and must not be removed until Pages and feature tests pass.

### Deploying Pages

The workflow `.github/workflows/cloudflare-pages-deploy.yml` builds the existing app, runs its existing test suite, creates the Pages project `aurora-voicetext` if needed, configures the two server-side Pages secrets, and deploys the production branch.

It uses these existing GitHub Actions secrets:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BACKUP_API_TOKEN` (the same value already configured on the Worker)

The Cloudflare API token must have permission to deploy Workers and manage Cloudflare Pages projects/deployments/secrets in the account identified by `CLOUDFLARE_ACCOUNT_ID`. The Pages deployment will fail clearly if the token lacks Pages permissions.

After the workflow succeeds, the Pages site will be available at `https://aurora-voicetext.pages.dev` (unless the project has a different assigned subdomain). Verify the frontend and `/api/health` before changing canonical SEO URLs, Android production API configuration, or the existing Vercel site.

### Manual verification checklist

1. Open the Pages production URL and confirm the existing AURORA VoiceText interface loads.
2. Open `/api/health`; it should return the same provider-status JSON as the Worker health endpoint.
3. Test a short transcription, transcript polish, translation, speech generation, subtitle search, and subtitle download where provider credentials permit.
4. Only after those checks pass, update canonical metadata, sitemap, robots, Google Search Console verification, and the Android API origin.
