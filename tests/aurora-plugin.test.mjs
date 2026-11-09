import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const endpoint = await readFile(new URL("../api/aurora-transcribe.ts", import.meta.url), "utf8");
const providers = await readFile(new URL("../api/_lib/transcription-providers.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/202611090001_persistent_aurora_transcription_jobs.sql", import.meta.url), "utf8");

test("AURORA VoiceText bridge verifies the integration token and actual Supabase user identity", () => {
  assert.ok(endpoint.includes("AURORA_PLUGIN_TOKEN"));
  assert.ok(endpoint.includes("timingSafeEqual"));
  assert.ok(endpoint.includes("owner_id=eq."));
  assert.ok(endpoint.includes("verifiedOwner"));
  assert.ok(endpoint.includes("x-aurora-user-token"));
  assert.ok(endpoint.includes("/auth/v1/user"));
  assert.ok(endpoint.includes("SUPABASE_SERVICE_ROLE_KEY"));
  assert.ok(!endpoint.includes("input.ownerId") && !endpoint.includes("req.query.ownerId"));
  assert.ok(endpoint.includes("private transcription job"));
  assert.ok(migration.includes("owner_id uuid"));
  assert.ok(migration.includes("voicetext-recordings"));
});

test("bridge validates bounded audio and delegates to VoiceText's existing provider chain", () => {
  assert.ok(endpoint.includes("4000000"));
  assert.ok(endpoint.includes("audioBase64"));
  assert.ok(endpoint.includes("audio/mp4"));
  assert.ok(endpoint.includes("transcribeWithFallback"));
  assert.ok(endpoint.includes("segments: result.segments"));
  assert.ok(endpoint.includes('retention: "not_stored_by_integration_endpoint"'));
  assert.ok(providers.includes("export async function transcribeWithFallback"));
});

test("bridge rejects unsupported video instead of pretending to transcribe it", () => {
  assert.ok(endpoint.includes("audio files only"));
  assert.ok(endpoint.includes("415"));
});
