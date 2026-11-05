# Android release preparation

## Local prerequisites

- Node.js and npm
- JDK 21
- Android Studio
- Android SDK Platform and Build Tools installed through Android Studio
- Android SDK environment variables configured

## Build an installable debug APK

From the repository root:

```bash
npm install
npm run android:apk
```

The script creates the Capacitor Android platform when it is missing, builds the Vite application, synchronizes Capacitor plugins and assets, then runs the Gradle debug APK task.

Output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

## Sync without assembling

```bash
npm run android:sync
```

## Release signing

A Play Store or shareable production release must be signed with a private keystore. Create and store the keystore outside the repository, configure signing through local Gradle properties or a secure CI secret store, and never commit the keystore or passwords. The current workflow intentionally builds a debug APK only; release signing is not configured.

## Important

This guide describes the implemented packaging workflow. It does not certify that the current source compiles or that the APK has been tested. Run the build and device checks when the project is ready for its testing phase.
