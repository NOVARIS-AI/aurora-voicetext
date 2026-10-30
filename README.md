# AURORA VoiceText

AURORA VoiceText is a browser-based voice-note workspace for importing audio, transcribing it online or on-device, editing transcripts, saving notes locally, and exporting text.

## Source migration

Retrieved from AppDeploy app `aurora-voicetext-xg91t1`, snapshot `1793285066502`. The original frontend component is preserved at `migration-source/App.original.tsx`; the original AppDeploy backend is preserved at `backend/index.ts`.

The active frontend uses same-origin `fetch('/api/transcribe')` instead of the AppDeploy client package. The Vercel API implementation is in `api/transcribe.ts`.

## Stack

- React 19, TypeScript, Vite
- Transformers.js with Whisper Tiny for on-device transcription
- Vercel serverless functions for online transcription
- Groq Whisper API for online transcription

## Local development

```bash
npm install
npm run dev
```

## Vercel deployment

Import this private GitHub repository into Vercel. Use the Vite preset, build command `npm run build`, and output directory `dist`.

For online transcription, create a server-side environment variable named `GROQ_API_KEY` in Vercel Project Settings → Environment Variables, then redeploy. Do not prefix it with `VITE_` and never commit the real secret. Until configured, on-device Whisper and manual transcript editing remain available; online mode will show a configuration error.

## Privacy and storage

The transcript library is stored in the current browser's local storage. Online mode sends audio chunks to the configured transcription provider. On-device mode downloads Whisper Tiny and processes audio in the browser.

## Migration status

The AppDeploy snapshot source files discovered during migration were copied into this repository. The original AppDeploy project was not deleted or modified. This repository is not yet a verified production deployment: install dependencies, run a build, configure the provider key, and test transcription on mobile before relying on it.
