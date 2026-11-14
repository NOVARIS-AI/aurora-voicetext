import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/cloudflare-pages-deploy.yml", import.meta.url), "utf8");
const proxy = await readFile(new URL("../functions/api/[endpoint].ts", import.meta.url), "utf8");
const health = await readFile(new URL("../functions/api/health.ts", import.meta.url), "utf8");

test("Cloudflare Pages deploy reuses the existing Cloudflare credential when a dedicated Pages token is absent", () => {
  assert.match(workflow, /secrets\.CLOUDFLARE_PAGES_API_TOKEN\s*\|\|\s*secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.CLOUDFLARE_ACCOUNT_ID/);
  assert.match(workflow, /secrets\.BACKUP_API_TOKEN/);
  assert.match(workflow, /wrangler pages deploy dist/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
});

test("Pages deployment is triggered by application, API proxy, Worker, and test changes", () => {
  for (const path of ["src/**", "functions/**", "api/**", "backup-worker/**", "tests/**"]) {
    assert.ok(workflow.includes("'" + path + "'"), "Missing Pages deployment trigger for " + path);
  }
});

test("Pages API proxy exposes only the supported Worker endpoints and keeps its token server-side", () => {
  for (const endpoint of ["transcribe", "tts", "assist", "translate", "voice-chat", "subtitles", "subtitles-download", "health", "admin", "bug-report", "diagnostics", "aurora-transcribe"]) {
    assert.ok(proxy.includes('"' + endpoint + '"'));
  }
  assert.match(proxy, /env\.BACKUP_API_TOKEN/);
  assert.match(proxy, /Authorization",\s*"Bearer "\s*\+\s*token/);
  assert.match(proxy, /ALLOWED_ENDPOINTS\.has\(endpoint\)/);
  assert.match(proxy, /redirect:\s*"manual"/);
  assert.doesNotMatch(proxy, /VITE_BACKUP_API_TOKEN/);
});

test("Pages health endpoint forwards the private Worker credential without exposing it", () => {
  assert.match(health, /env\.BACKUP_API_TOKEN/);
  assert.match(health, /Authorization:\s*"Bearer "\s*\+\s*token/);
  assert.match(health, /Cache-Control/);
  assert.doesNotMatch(health, /VITE_BACKUP_API_TOKEN/);
});


test("Cloudflare Pages keeps administrative Vercel routes available without exposing Worker secrets", () => {
  assert.match(proxy, /VERCEL_API_ENDPOINTS/);
  assert.match(proxy, /https:\/\/aurora-voicetext-qk8s\.vercel\.app/);
  assert.match(proxy, /if \(!isVercelEndpoint\) forwardedHeaders\.set\("Authorization"/);
});

test("Voice Workspace chat is implemented in the backup Worker and advertised by health", async () => {
  const worker = await readFile(new URL("../backup-worker/src/index.ts", import.meta.url), "utf8");
  assert.match(worker, /\/api\/voice-chat/);
  assert.match(worker, /async function voiceChat\(/);
  assert.match(worker, /voiceChat:\s*Boolean\(env\.OPENROUTER_API_KEY \|\| env\.GROQ_API_KEY \|\| env\.OPENAI_API_KEY\)/);
  assert.match(worker, /GROQ_CHAT_MODEL/);
});

test("Native Android builds use the production Cloudflare Pages API gateway", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /https:\/\/aurora-voicetext\.pages\.dev/);
  assert.match(app, /<AdminPanel apiBaseUrl=\{API_BASE_URL\}/);
  assert.match(app, /<BugReporter page=\{page\} apiBaseUrl=\{API_BASE_URL\}/);
});


test("Cloudflare Pages sends user-facing APIs to the primary server with independent Worker fallback", async () => {
  const primary = await readFile(new URL("../functions/api/[endpoint].ts", import.meta.url), "utf8");
  const voiceChat = await readFile(new URL("../api/voice-chat.ts", import.meta.url), "utf8");
  const backup = await readFile(new URL("../api/_lib/backup.ts", import.meta.url), "utf8");
  for (const endpoint of ["transcribe", "tts", "assist", "translate", "voice-chat"]) {
    assert.ok(primary.includes('"' + endpoint + '"'), "Missing primary API route " + endpoint);
  }
  assert.doesNotMatch(primary.match(/const VERCEL_API_ENDPOINTS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "", /"subtitles(?:-download)?"/);
  assert.match(primary, /new URL\(workerPath, VERCEL_API_BASE_URL\)/);
  assert.match(voiceChat, /callBackup\("\/api\/voice-chat"/);
  assert.match(backup, /"\/api\/voice-chat"/);
});


test("Android APK build uses Cloudflare Pages rather than the legacy Vercel API base", async () => {
  const workflow = await readFile(new URL("../.github/workflows/android-apk.yml", import.meta.url), "utf8");
  assert.match(workflow, /VITE_API_BASE_URL:\s*https:\/\/aurora-voicetext\.pages\.dev/);
  assert.match(workflow, /VITE_BACKUP_API_PUBLIC_FALLBACK:\s*'false'/);
});


test("Cloudflare gateway preserves GET status checks for resumable transcription jobs", async () => {
  assert.match(proxy, /endpoint === "aurora-transcribe"/);
  assert.match(proxy, /\["GET", "POST"\]\.includes\(request\.method\)/);
  assert.match(proxy, /target\.search = new URL\(request\.url\)\.search/);
});

test("Backup Worker deploy name, Pages health target, and provider readiness stay aligned", async () => {
  const workerConfig = await readFile(new URL("../backup-worker/wrangler.toml", import.meta.url), "utf8");
  const worker = await readFile(new URL("../backup-worker/src/index.ts", import.meta.url), "utf8");
  assert.match(workerConfig, /^name = "aurora-voicetext-backup"$/m);
  assert.match(health, /aurora-voicetext-backup\.schoolershubit5\.workers\.dev/);
  assert.match(worker, /openrouter:\s*Boolean\(env\.OPENROUTER_API_KEY\)/);
  assert.match(worker, /subtitleDownload:\s*Boolean\(env\.OPENSUBTITLES_API_KEY && env\.OPENSUBTITLES_USERNAME && env\.OPENSUBTITLES_PASSWORD\)/);
});


test("Cloudflare gateway falls back to the authenticated Worker only for supported primary API failures", () => {
  assert.match(proxy, /workerFallbackEndpoints = new Set\(\["transcribe", "tts", "translate", "voice-chat"\]\)/);
  assert.match(proxy, /request\.clone\(\)/);
  assert.match(proxy, /upstream\.status >= 500/);
  assert.match(proxy, /fallbackHeaders\.set\("Authorization", "Bearer " \+ workerToken\)/);
  assert.match(proxy, /AbortSignal\.timeout\(110000\)/);
  assert.match(proxy, /Both upstreams failed/);
  assert.doesNotMatch(proxy.match(/const workerFallbackEndpoints[\s\S]*?const makeResponse/)?.[0] || "", /"admin"|"bug-report"|"diagnostics"|"aurora-transcribe"/);
});

test("movie detail subtitle action is explicitly caption preview, not film preview", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /Preview captions/);
  assert.match(app, /Spotify <span>Soundtracks & audio/);
});

test("production README documents Cloudflare Pages and Nigerian language validation honestly", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Cloudflare Pages/);
  assert.match(readme, /Nigerian English and Nigerian Pidgin/);
  assert.match(readme, /small US-English model/);
  assert.match(readme, /do not prove that a title is available/);
});


test("TTS recovers from a stale ElevenLabs voice ID by resolving an active account voice", async () => {
  const providers = await readFile(new URL("../api/_lib/ai-providers.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../backup-worker/src/index.ts", import.meta.url), "utf8");
  for (const source of [providers, worker]) {
    assert.match(source, /v1\/voices/);
    assert.match(source, /response\.status === 404/);
    assert.match(source, /elevenlabs-account-fallback/);
    assert.match(source, /OPENAI_API_KEY/);
  }
});

test("App remembers the last page and confirms media, transcript, and Library deletion", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /aurora-voicetext-last-page-v1/);
  assert.match(app, /Clear the entire transcript/);
  assert.match(app, /Remove .* from this project/);
  assert.match(app, /Delete .* from your Library/);
});

test("Subtitle results are deduplicated and grouped into one artwork card per title", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /seenReleases/);
  assert.match(app, /subtitleResultGroups/);
  assert.match(app, /distinct subtitle releases/);
  assert.doesNotMatch(app, /MORE RELEASES/);
});

test("Documents open as a dedicated full-page WPS-style editor with editing and export tools", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const document = await readFile(new URL("../src/DocumentStudio.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/aurora-upgrade.css", import.meta.url), "utf8");
  assert.match(app, /page !== 'documents' && <nav/);
  assert.match(app, /document-app-shell/);
  assert.match(document, /document-paper-editor/);
  assert.match(document, /replaceAll/);
  assert.match(document, /insertTable/);
  assert.match(document, /exportDocx/);
  assert.match(document, /window\.print/);
  assert.match(document, /Replace the current document with a blank one/);
  assert.match(styles, /Dedicated WPS-style document workspace/);
});
