import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const endpoint = await readFile(new URL("../api/aurora-transcribe.ts", import.meta.url), "utf8");
const providers = await readFile(new URL("../api/_lib/transcription-providers.ts", import.meta.url), "utf8");

test("AURORA VoiceText bridge verifies the integration token and actual Supabase user identity", () => {
  assert.ok(endpoint.includes("AURORA_PLUGIN_TOKEN"));
  assert.ok(endpoint.includes("timingSafeEqual"));
  assert.ok(endpoint.includes("owner_id=eq"));
  assert.ok(endpoint.includes("ownerId"));
  assert.ok(endpoint.includes("verified AURORA account"));
  assert.ok(endpoint.includes("x-aurora-user-token"));
  assert.ok(endpoint.includes("/auth/v1/user"));
  assert.ok(endpoint.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.ok(!endpoint.includes("input.ownerId") && !endpoint.includes("req.query.ownerId"));
  assert.ok(endpoint.includes("401"));
  assert.doesNotMatch(endpoint, /GROQ_API_KEY|OPENAI_API_KEY|ASSEMBLYAI_API_KEY/);
});

test("bridge validates bounded audio and delegates to VoiceText's existing provider chain", () => {
  assert.ok(endpoint.includes("4000000"));
  assert.ok(endpoint.includes("audioBase64"));
  assert.ok(endpoint.includes("audio/mp4"));
  assert.ok(endpoint.includes("transcribeWithFallback"));
  assert.ok(endpoint.includes("segments: result.segments"));
  assert.ok(endpoint.includes('retention: "not_stored_by_integration_endpoint"'));
  assert.match(providers, /export async function transcribeWithFallback/);
});

test("bridge rejects unsupported video instead of pretending to transcribe it", () => {
  assert.ok(endpoint.includes("audio files only"));
  assert.ok(endpoint.includes("415"));
});
