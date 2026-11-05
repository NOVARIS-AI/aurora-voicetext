import test from "node:test";
import assert from "node:assert/strict";
import { shouldTryNextTranscriptionProvider } from "../api/_lib/transcription-provider-policy.mjs";

test("stops provider fallback when the audio payload is too large", () => {
  assert.equal(shouldTryNextTranscriptionProvider(413), false);
});

test("stops provider fallback for unsupported audio media types", () => {
  assert.equal(shouldTryNextTranscriptionProvider(415), false);
});

test("continues provider fallback for provider-specific and transient errors", () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503, undefined]) {
    assert.equal(shouldTryNextTranscriptionProvider(status), true, "status " + status);
  }
});
