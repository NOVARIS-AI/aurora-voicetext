import test from "node:test";
import assert from "node:assert/strict";
import { getBackupHealth } from "../api/_lib/backup-health.mjs";

test("reports an unconfigured backup without making a request", async () => {
  let called = false;
  const result = await getBackupHealth({}, async () => {
    called = true;
    throw new Error("must not be called");
  });
  assert.deepEqual(result, { configured: false, status: "not-configured" });
  assert.equal(called, false);
});

test("checks the backup Worker using the server-side bearer token", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const result = await getBackupHealth({
    BACKUP_BACKEND_URL: "https://backup.example.workers.dev/",
    BACKUP_BACKEND_TOKEN: "private-token",
  }, async (url, options) => {
    requestedUrl = url;
    requestedAuthorization = options.headers.Authorization;
    return new Response(JSON.stringify({
      service: "aurora-voicetext-backup",
      status: "ok",
      providers: { transcription: true, speech: false, translation: true },
    }), { status: 200 });
  });

  assert.equal(requestedUrl, "https://backup.example.workers.dev/health");
  assert.equal(requestedAuthorization, "Bearer private-token");
  assert.deepEqual(result, {
    configured: true,
    status: "ok",
    service: "aurora-voicetext-backup",
    providers: {
      transcription: true,
      speech: false,
      openrouter: false,
      voiceChat: false,
      translation: true,
      transcriptPolish: false,
      subtitles: false,
      subtitleDownload: false,
    },
  });
});

test("reports non-OK backup responses as unavailable", async () => {
  const result = await getBackupHealth({
    BACKUP_BACKEND_URL: "https://backup.example.workers.dev",
    BACKUP_BACKEND_TOKEN: "private-token",
  }, async () => new Response("unavailable", { status: 503 }));
  assert.deepEqual(result, { configured: true, status: "unavailable", httpStatus: 503 });
});

test("rejects an insecure remote backup URL", async () => {
  const result = await getBackupHealth({
    BACKUP_BACKEND_URL: "http://backup.example.com",
    BACKUP_BACKEND_TOKEN: "private-token",
  }, async () => {
    throw new Error("must not be called");
  });
  assert.deepEqual(result, { configured: true, status: "invalid-configuration" });
});
