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
  for (const endpoint of ["transcribe", "tts", "assist", "translate", "subtitles", "subtitles-download", "health"]) {
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
