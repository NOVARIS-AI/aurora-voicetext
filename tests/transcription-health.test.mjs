import test from "node:test";
import assert from "node:assert/strict";
import { getTranscriptionHealth, getTranscriptionProviderStatus } from "../api/_lib/transcription-health.mjs";

test("reports missing online transcription configuration clearly", () => {
  const health = getTranscriptionHealth({});
  assert.equal(health.status, "needs-configuration");
  assert.equal(health.onlineTranscriptionAvailable, false);
  assert.deepEqual(health.providers, { assemblyai: false, groq: false, openai: false });
});

test("reports configured providers without exposing secret values", () => {
  const env = {
    ASSEMBLYAI_API_KEY: "assembly-secret",
    GROQ_API_KEY: "",
    OPENAI_API_KEY: "openai-secret",
  };
  assert.deepEqual(getTranscriptionProviderStatus(env), {
    assemblyai: true, groq: false, openai: true,
  });
  const serialized = JSON.stringify(getTranscriptionHealth(env));
  assert.equal(serialized.includes("assembly-secret"), false);
  assert.equal(serialized.includes("openai-secret"), false);
});

test("reports online transcription ready when any provider is configured", () => {
  const health = getTranscriptionHealth({ GROQ_API_KEY: "configured" });
  assert.equal(health.status, "ready");
  assert.equal(health.onlineTranscriptionAvailable, true);
  assert.equal(health.providers.groq, true);
  assert.match(health.checkedAt, /^\\d{4}-\\d{2}-\\d{2}T/);
});
