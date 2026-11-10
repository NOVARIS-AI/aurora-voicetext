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
  assert.ok(endpoint.includes("async function verifiedOwner"));
  assert.ok(endpoint.includes("typeof user.id === \"string\""));
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


test("persistent jobs enforce ordered bounded sections and owner-scoped checkpoints", () => {
  assert.ok(endpoint.includes("chunkNumber > totalChunks"));
  assert.ok(endpoint.includes("chunkNumber !== job.completed_chunks + 1"));
  assert.ok(endpoint.includes("completed_chunks=eq."));
  assert.ok(endpoint.includes("owner_id=eq."));
  assert.ok(endpoint.includes("current.completed_chunks >= target"));
  assert.ok(endpoint.includes("status: done ? \"completed\" : \"processing\""));
  assert.ok(endpoint.includes("storage/v1/object/"));
  assert.ok(endpoint.includes("encodeURIComponent(bucket)"));
});

test("persistent job storage migration is private and bounded", async () => {
  const migration = await readFile(new URL("../supabase/migrations/202611090001_persistent_aurora_transcription_jobs.sql", import.meta.url), "utf8");
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /public, file_size_limit/);
  assert.match(migration, /'voicetext-recordings',[\s\S]*?false[\s\S]*?5242880/);
  assert.match(migration, /owner_id uuid references auth\.users\(id\) on delete cascade/);
  assert.match(migration, /completed_chunks integer not null default 0/);
  assert.match(migration, /check \(status in \('created','uploading','uploaded','processing','completed','failed'\)\)/);
});
