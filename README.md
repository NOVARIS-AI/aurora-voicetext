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


## AMET — AURORA Multi-Engine Transcription

Auto mode tries Whisper Tiny in-browser, then Vosk Browser offline, then Groq Whisper online. Offline mode never sends audio to the server. Online mode uses the existing Vercel transcription endpoint.

Vosk requires a compatible gzipped Vosk model archive hosted with browser CORS and worker access. Configure `VITE_VOSK_MODEL_URL` in the deployment environment before rebuilding. The model is not bundled in this repository. Vosk model compatibility and Nigerian English/Pidgin accuracy still require real-device testing.


## Android APK workflow

The repository now includes a repeatable Capacitor Android packaging command. It creates the Android platform project if it is not present, builds the web app, syncs the web assets and native plugins, and assembles a debug APK.

Prerequisites:
- Node.js and npm dependencies installed with `npm install`
- JDK 21
- Android Studio with an Android SDK and platform build tools installed
- Android SDK environment configured for the local machine

Build the debug APK:

```bash
npm run android:apk
```

The resulting file is:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

For an existing Android project, `npm run android:sync` rebuilds the web assets and syncs them into the native project without assembling an APK. To create the native project separately, run `npm run android:setup`.

The debug APK is for installation and internal evaluation; it is not a Play Store release. A distributable release requires a privately managed signing keystore and release signing configuration. Never commit keystore files, passwords or signing secrets.

## App identity and search metadata

The canonical public website for this project is `https://aurora-voicetext-qk8s.vercel.app/`. The HTML canonical link, Open Graph URL, SoftwareApplication structured-data URL, XML sitemap entry and `robots.txt` sitemap directive all use this same host. The web app also includes an AURORA VoiceText SVG favicon, installable PWA icon variants, a refined web manifest and crawler directives. Search Console ownership verification and sitemap submission still require the site owner to complete the steps in Google's account; no verification token is stored in this repository.

## Implementation status

The current development branch contains the reliability, provider fallback, long-audio recovery, Voice Studio and Audio Editor foundations, plus branding and Android packaging preparation. Automated tests, production builds, real-device checks and release signing have deliberately not been run as part of this implementation pass.
