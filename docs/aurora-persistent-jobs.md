# AURORA persistent transcription jobs

The server-to-server integration endpoint is `/api/aurora-transcribe`. Every request must include:

```http
Authorization: Bearer <AURORA_PLUGIN_TOKEN>
Content-Type: application/json
```

The token stays in AURORA's server-side configuration. Never put it in a browser bundle, Android APK, or public client environment variable.

## 1. Create a job

Send the recording metadata before sending sections:

```json
{
  "action": "create",
  "filename": "lecture-recording.m4a",
  "mimeType": "audio/mp4",
  "sizeBytes": 18400000,
  "durationSeconds": 720,
  "totalChunks": 24
}
```

The response includes `requestId`, `status`, `completedChunks`, `totalChunks`, and `progress`. Save `requestId` in AURORA's durable local job list.

## 2. Process sections in order

Send one audio section per request:

```json
{
  "action": "process",
  "requestId": "<requestId returned by create>",
  "chunkNumber": 1,
  "totalChunks": 24,
  "mimeType": "audio/mp4",
  "languageHint": "Nigerian English and Nigerian Pidgin may be mixed; preserve both",
  "audioBase64": "<base64 for this section>"
}
```

Each successful response contains the cumulative transcript and updated progress. The server stores each section in the private Supabase bucket before transcription and retains the section objects with the job. Process sections sequentially. A retry of an already completed section is idempotent; an out-of-order section receives HTTP 409 with the next expected section.

## 3. Resume or retrieve results

Poll:

```http
GET /api/aurora-transcribe?requestId=<requestId>
```

The response includes the saved transcript, status, completed/total sections, progress, and timestamps. After an app restart, load the saved request ID, call this status endpoint, and resume at `completedChunks + 1`.

## Important operating limits

- Each section must fit the endpoint's request-body limit (about 3 MB of audio data).
- The API persists progress and results, but it does not run a background worker after the caller disconnects. AURORA must continue sending sections while it is active, then can resume later from the saved checkpoint.
- Apply the Supabase migration `202611090001_persistent_aurora_transcription_jobs.sql` before using persistent jobs.
- The job API is protected by the server-side AURORA integration token; do not expose it to end users.
