# AURORA VoiceText

AURORA VoiceText is a mobile-first voice-note and media workspace for importing audio/video, transcribing online or on-device, working with subtitles, chatting with AI, saving transcripts locally, and exporting finished work.

## Production

- **Web app:** https://aurora-voicetext.pages.dev/
- **Source of truth:** this GitHub repository, branch `main`
- **Hosting:** Cloudflare Pages
- **API gateway:** Cloudflare Pages Functions
- **Backup API:** the private `aurora-voicetext-backup` Cloudflare Worker
- **Legacy primary API:** Vercel remains the primary upstream for selected endpoints; Cloudflare Pages can fall back to the Worker for transcription, speech, translation, and voice chat when the primary returns a server error or cannot be reached.

Push changes to `main` to run the GitHub Actions checks and deploy the production Pages site. Do not deploy this project directly from the Vercel dashboard.

## Stack

- React 19, TypeScript, Vite
- Capacitor 7 for Android
- Transformers.js Whisper Tiny and Vosk Browser for on-device transcription
- Cloudflare Pages Functions gateway and a private Cloudflare Worker backup
- Configured online transcription, translation, voice, and subtitle providers

## Local development

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm test
npm run typecheck
npm run build
```

The production build runs tests, the strict TypeScript check, and the Vite build in sequence.

## Cloudflare configuration

The Pages project requires server-side `BACKUP_API_TOKEN` and `BACKUP_API_BASE_URL` secrets. The Worker requires the matching `BACKUP_API_TOKEN` plus provider secrets for the features enabled on the account. Keep all credentials in Cloudflare/GitHub Actions secrets; never add provider keys to `VITE_*` variables or commit them.

The Pages gateway keeps the Worker token server-side. Vercel remains primary for the routes that still use it. When supported user-facing endpoints fail at the primary with a 5xx/network error, the gateway retries the request through the authenticated Worker. Administrative and diagnostic routes remain on their configured primary service because the Worker does not implement those endpoints.

## Transcription languages and offline models

Online transcription uses the configured provider chain and receives the language/context hint from the app. AURORA is being tuned for Nigerian English and Nigerian Pidgin, but recognition quality depends on the selected provider and should be verified with real recordings from the target device and speakers.

The optional Vosk offline model is configured with `VITE_VOSK_MODEL_URL`. The existing default is a small US-English model, not a Nigerian English/Pidgin model. It remains a generic offline fallback and must not be described as Nigerian-language support. A compatible model archive must allow browser CORS and worker access. The model is downloaded on demand and is not bundled in this repository.

## Subtitle Finder

Movie results open a film-details view with available metadata and streaming-service search destinations. Those destinations search the selected title; they do not prove that a title is available in a particular catalogue or region. Spotify is labelled for soundtrack/audio discovery rather than film streaming. Subtitle-file preview is a separate action from film details.

## Privacy and storage

The transcript library is stored in the current browser's local storage. Online transcription and AI features send the relevant text/audio to the configured service provider. Offline transcription processes audio on-device after the required model is available. Review provider terms and the app's permissions before using sensitive recordings.

## Testing notes

Automated checks cover core utilities, API gateway contracts, health reporting, and build-time TypeScript validation. Full end-to-end Android and browser journeys still require device/browser testing, especially offline model download, Nigerian English/Pidgin accuracy, exports, subtitle playback, and provider outages.
