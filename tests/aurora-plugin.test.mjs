import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const endpoint = await readFile(new URL("../api/aurora-transcribe.ts", import.meta.url), "utf8");
const providers = await readFile(new URL("../api/_lib/transcription-providers.ts", import.meta.url), "utf8");

test("AURORA VoiceText bridge is server-authenticated and never exposes provider keys", () => {
  assert.match(endpoint, /AURORA_PLUGIN_TOKEN/);
  assert.match(endpoint, /timingSafeEqual/);
  assert.match(endpoint, /401/);
  assert.doesNotMatch(endpoint, /GROQ_API_KEY|OPENAI_API_KEY|ASSEMBLYAI_API_KEY/);
});

test("bridge validates bounded audio and delegates to VoiceText's existing provider chain", () => {
  assert.match(endpoint, /4000000/);
  assert.match(endpoint, /audioBase64/);
  assert.match(endpoint, /audio\/mp4/);
  assert.match(endpoint, /transcribeWithFallback/);
  assert.match(endpoint, /segments: result\.segments/);
  assert.match(endpoint, /retention: "not_stored_by_integration_endpoint"/);
  assert.match(providers, /export async function transcribeWithFallback/);
});

test("bridge rejects unsupported video instead of pretending to transcribe it", () => {
  assert.match(endpoint, /audio files only/);
  assert.match(endpoint, /415/);
});
