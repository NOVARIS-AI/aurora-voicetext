import { useEffect, useRef, useState } from 'react';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createEstimatedSubtitles, createTimedSubtitles, mergeTranscriptParts, normalizeSubtitleText, safeAudioInputName, chooseAudioSegmentSeconds, throwIfTranscriptionAborted, createNativeAudioResumeKey, isValidTranscriptionCheckpoint } from './audio-utils';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import {
  AudioLines, Upload, FileAudio, X, Copy, Download, Plus, Sparkles, ChevronDown, Check,
  ShieldCheck, WandSparkles, LoaderCircle, FileText,
  Mic2, Volume2, BookOpen, Trash2, Save, Languages, Search, FileDown, AudioWaveform,
} from 'lucide-react';

type Recording = { id: string; name: string; transcript: string; updatedAt: number };
type PreviewMessage = { id: string; role: 'user' | 'assistant'; text: string };
type TimedSegment = { start: number; end: number; text: string; speaker?: string };
type NativeAudioDetails = { codec?: string; sampleRate?: number; channels?: number };
type NativeAudioFilesBridge = { pick: () => Promise<{ files: Array<{ path: string; name: string; size: number; mimeType?: string; durationMs?: number; contentHash?: string; audioInfo?: NativeAudioDetails }> }>; decodeSegment: (options: { path: string; startSeconds: number; durationSeconds: number }) => Promise<{ wavBase64: string; sampleRate: number; channels: number; durationSeconds: number }> };
const nativeAudioFiles = registerPlugin<NativeAudioFilesBridge>('NativeAudioFiles');
type NativeSpeechWord = { word: string; start: number; end: number; conf?: number };
type NativeSpeechBridge = {
  prepareModel: () => Promise<{ ready: boolean; model: string }>;
  transcribeSegment: (options: { path: string; startSeconds: number; durationSeconds: number }) => Promise<{ text: string; words?: NativeSpeechWord[]; engine: string }>;
  cancel: () => Promise<void>;
  releaseModel: () => Promise<void>;
};
const nativeSpeech = registerPlugin<NativeSpeechBridge>('NativeSpeech');
type BackgroundTranscriptionBridge = { start: () => Promise<void>; update: (options: { message: string }) => Promise<void>; stop: () => Promise<void> };
const backgroundTranscription = registerPlugin<BackgroundTranscriptionBridge>('BackgroundTranscription');
type AudioFile = { id: string; file: File; url: string; transcript: string; translatedTranscript?: string; detectedLanguage?: string; timedSegments?: TimedSegment[]; nativePath?: string; nativeSize?: number; nativeDurationMs?: number; nativeFingerprint?: string; nativeAudioInfo?: NativeAudioDetails };
type Page = 'home' | 'transcribe' | 'library' | 'preview' | 'studio'  | 'subtitles' | 'settings';
type Engine = (audio: Float32Array, options: { sampling_rate: number; chunk_length_s?: number; stride_length_s?: number; return_timestamps?: boolean }) => Promise<{ text?: string; chunks?: Array<{ text?: string; timestamp?: [number | null, number | null] }> }>;
type TranscriptionMode = 'auto' | 'offline' | 'online';
type TranscriptionCheckpoint = { fileId: string; mode: 'online' | 'offline'; segmentSeconds: number; overlapSeconds: number; parts: string[]; nextChunk: number; totalChunks: number; segments?: TimedSegment[] };

const STORAGE_KEY = 'aurora-voicetext-library-v2';
// Browser builds use same-origin API routes. Capacitor runs on https://localhost, so
// native builds must use the deployed API origin unless explicitly overridden at build time.
const API_BASE_URL = (() => {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  const fallback = Capacitor.isNativePlatform() ? 'https://aurora-voicetext.vercel.app' : '';
  const candidate = configured || fallback;
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    // Cloudflare Workers are backup services, not the primary app API: the
    // Vercel routes hold the private backup token for TTS/subtitle failover.
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') return fallback;
    if (parsed.hostname.endsWith('.workers.dev')) return fallback;
    return candidate.replace(/\/+$/, '');
  } catch { return fallback; }
})();
const BACKUP_API_PUBLIC_FALLBACK = (import.meta.env.VITE_BACKUP_API_PUBLIC_FALLBACK as string | undefined) === 'true';
// The Worker is private by default. Only call it directly from the app when public fallback has
// deliberately been enabled after rate limiting; otherwise Vercel proxies to it server-side.
const BACKUP_API_BASE_URL = BACKUP_API_PUBLIC_FALLBACK
  ? ((import.meta.env.VITE_BACKUP_API_BASE_URL as string | undefined) || 'https://aurora-voicetext.alwerioghenepeace563.workers.dev').replace(/\/+$/, '')
  : '';
const transcriptionApiUrl = `${API_BASE_URL}/api/transcribe`;
const backupTranscriptionApiUrl = BACKUP_API_BASE_URL ? `${BACKUP_API_BASE_URL}/api/transcribe` : '';
let pipelinePromise: Promise<Engine> | null = null;
let voskModelPromise: Promise<any> | null = null;
const VOSK_MODEL_URL = (import.meta.env.VITE_VOSK_MODEL_URL as string | undefined) ||
  'https://fiddle-app.github.io/voice-models/vosk-model-small-en-us-0.15.tar.gz';
const VOSK_MODEL_CACHE_NAME = 'aurora-voicetext-vosk-model-v1';
const VOSK_MODEL_CACHE_KEY = 'https://aurora-voicetext.local/offline-models/vosk-model-small-en-us-0.15.tar.gz';

// Send JSON API requests through Android's native HTTP stack in Capacitor builds.
 // This avoids WebView CORS restrictions without routing large model/audio downloads
 // through the native bridge. Browser builds continue to use standard fetch.
async function postJson(url: string, payload: unknown, readTimeout = 120000, signal?: AbortSignal): Promise<Response> {
  throwIfTranscriptionAborted(signal);
  if (Capacitor.isNativePlatform()) {
    const nativeResponse = await CapacitorHttp.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      data: payload,
      responseType: 'json',
      connectTimeout: 20000,
      readTimeout,
    });
    // CapacitorHttp does not expose AbortSignal cancellation; discard its result
    // immediately if the user cancelled while the native request was in flight.
    throwIfTranscriptionAborted(signal);
    const headers = new Headers({ 'Content-Type': 'application/json' });
    for (const [key, value] of Object.entries(nativeResponse.headers || {})) {
      if (typeof value === 'string') headers.set(key, value);
    }
    return new Response(JSON.stringify(nativeResponse.data ?? {}), {
      status: nativeResponse.status,
      headers,
    });
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal || (readTimeout < 120000 ? AbortSignal.timeout(readTimeout) : undefined),
  });
}

async function postBinary(url: string, payload: unknown, readTimeout = 120000): Promise<Response> {
  if (!Capacitor.isNativePlatform()) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: readTimeout < 120000 ? AbortSignal.timeout(readTimeout) : undefined,
    });
  }
  const nativeResponse = await CapacitorHttp.request({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'audio/mpeg, application/octet-stream, application/json' },
    data: payload,
    responseType: 'arraybuffer',
    connectTimeout: 20000,
    readTimeout,
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(nativeResponse.headers || {})) {
    if (typeof value === 'string') headers.set(key, value);
  }
  let body: BodyInit | null = null;
  const raw = nativeResponse.data;
  if (nativeResponse.status >= 200 && nativeResponse.status < 300) {
    if (typeof raw === 'string') {
      // Capacitor's Android arraybuffer response is transported to JavaScript as base64.
      const encoded = raw.replace(/\\s/g, '');
      const decoded = atob(encoded);
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      body = bytes.buffer;
    } else if (raw instanceof ArrayBuffer) {
      body = raw;
    } else if (ArrayBuffer.isView(raw)) {
      // Copy into a standalone ArrayBuffer so TypeScript and the WebView Response
      // constructor do not receive an ArrayBufferLike-backed typed array.
      const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      body = copy.buffer;
    } else if (raw != null) {
      body = JSON.stringify(raw);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
  } else if (raw != null) {
    body = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  return new Response(body, { status: nativeResponse.status, headers });
}

async function requestFeature(path: string, payload: unknown, binary = false): Promise<{ response: Response; data?: any }> {
  const primary = API_BASE_URL ? API_BASE_URL + path : path;
  // Feature endpoints (AI voice, subtitles, translation) stay on the primary
  // server, which can call the private Worker using BACKUP_BACKEND_TOKEN.
  // Only transcription uses the explicitly rate-limited public Worker fallback.
  const urls = [primary];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = binary ? await postBinary(url, payload) : await postJson(url, payload);
      if (response.ok) return { response, data: binary ? undefined : await response.json() };
      const body = binary ? null : await response.json().catch(() => null);
      lastError = new Error(body?.error || 'The service is temporarily unavailable.');
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error('The requested service is unavailable. Configure the primary or backup backend.');
}

function splitLongText(text: string, max = 22000): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.55) cut = remaining.lastIndexOf(' ', max);
    if (cut < max * 0.55) cut = max;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function splitSubtitleDocument(text: string, max = 18000): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const isVtt = normalized.startsWith('WEBVTT');
  const header = isVtt ? normalized.slice(0, normalized.indexOf('\n') < 0 ? normalized.length : normalized.indexOf('\n')).trim() + '\n\n' : '';
  const body = isVtt ? normalized.slice(header.trim().length).trim() : normalized;
  const blocks = body.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = header;
  for (const block of blocks) {
    if (current.length > header.length && current.length + block.length + 2 > max) {
      chunks.push(current.trim()); current = '';
    }
    current += (current ? '\n\n' : '') + block;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [normalized];
}

function combineMp3Chunks(parts: Blob[]): Blob {
  const usable = parts.filter(part => part.size > 0);
  if (!usable.length) throw new Error('No generated audio was received.');
  // Keep compressed MP3 chunks intact; decoding every section into PCM and
  // rebuilding a large WAV is memory-heavy on low-RAM Android devices.
  return new Blob(usable, { type: 'audio/mpeg' });
}

function readLibrary(): Recording[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}


const CHECKPOINT_DB = 'aurora-voicetext-checkpoints-v1';
function openCheckpointDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable.')); return; }
    const request = indexedDB.open(CHECKPOINT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints', { keyPath: 'fileKey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open checkpoint storage.'));
  });
}
async function readSavedCheckpoint(fileKey: string): Promise<TranscriptionCheckpoint | null> {
  const db = await openCheckpointDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('checkpoints', 'readonly').objectStore('checkpoints').get(fileKey);
      request.onsuccess = () => resolve(request.result?.checkpoint ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function writeSavedCheckpoint(fileKey: string, checkpoint: TranscriptionCheckpoint): Promise<void> {
  const db = await openCheckpointDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('checkpoints', 'readwrite');
      transaction.objectStore('checkpoints').put({ fileKey, checkpoint, savedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not commit the transcription checkpoint.'));
      transaction.onabort = () => reject(transaction.error || new Error('Transcription checkpoint save was interrupted.'));
    });
  } finally { db.close(); }
}
async function removeSavedCheckpoint(fileKey: string): Promise<void> {
  const db = await openCheckpointDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('checkpoints', 'readwrite');
      transaction.objectStore('checkpoints').delete(fileKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not clear the completed checkpoint.'));
      transaction.onabort = () => reject(transaction.error || new Error('Checkpoint cleanup was interrupted.'));
    });
  } finally { db.close(); }
}

async function pruneSavedCheckpoints(maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await openCheckpointDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('checkpoints', 'readwrite');
      const store = transaction.objectStore('checkpoints');
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const savedAt = Number((cursor.value as { savedAt?: number }).savedAt || 0);
        if (!savedAt || Date.now() - savedAt > maxAgeMs) cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Could not inspect saved transcription checkpoints.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Checkpoint retention cleanup failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Checkpoint retention cleanup was interrupted.'));
    });
  } finally { db.close(); }
}

/**
 * Keep decoder working sets smaller on constrained phones.
 * This reduces per-section memory use; it does not yet make whole-file
 * FFmpeg input loading streaming/disk-backed.
 */
function getAudioSegmentSeconds(mode: 'online' | 'offline' = 'online'): number {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency || 2;
  return chooseAudioSegmentSeconds({ native: Capacitor.isNativePlatform(), memory, cores, mode });
}

function isUsableCheckpoint(
  value: unknown,
  fileId: string,
  totalChunks: number,
  mode: 'online' | 'offline',
  segmentSeconds: number,
  overlapSeconds: number,
): value is TranscriptionCheckpoint {
  return isValidTranscriptionCheckpoint(value, {
    fileId, totalChunks, mode, segmentSeconds, overlapSeconds,
  });
}

async function makeAudioFileKey(file: File, nativePath?: string, nativeSize?: number, nativeFingerprint?: string): Promise<string> {
  // Android imports are copied to a new private path each time the user reopens a recording.
  // Use a content hash rather than that temporary path/current import timestamp so checkpoints
  // survive closing the app and selecting the same source recording again.
  const identity = nativePath
    ? createNativeAudioResumeKey({ name: file.name, size: nativeSize ?? file.size, mimeType: file.type, contentHash: nativeFingerprint })
    : [file.name, file.size, file.lastModified, file.type].join('|');
  // Android native offline decoding reads directly from app-private storage; do not
  // materialize or hash the entire recording in the WebView just to create a resume key.
  if (nativePath) return identity;
  try {
    if (!globalThis.crypto?.subtle) return identity;
    // Sample across the recording, not just its head and tail, to reduce resume-key collisions.
    const sampleSize = Math.min(64 * 1024, Math.max(1, Math.floor(file.size / 5)));
    const maxOffset = Math.max(0, file.size - sampleSize);
    const offsets = [0, 0.25, 0.5, 0.75, 1].map(fraction => Math.floor(maxOffset * fraction));
    const samples = await Promise.all(offsets.map(offset => file.slice(offset, offset + sampleSize).arrayBuffer()));
    const sample = new Uint8Array(samples.reduce((total, item) => total + item.byteLength, 0));
    let sampleOffset = 0;
    for (const item of samples) { sample.set(new Uint8Array(item), sampleOffset); sampleOffset += item.byteLength; }
    const digest = await globalThis.crypto.subtle.digest('SHA-256', sample);
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return identity + '|' + fingerprint;
  } catch { return identity; }
}

function isVideoMediaFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name);
}

async function getAudioDurationSeconds(file: File): Promise<number> {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement(isVideoMediaFile(file) ? 'video' : 'audio');
    media.preload = 'metadata';
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error('Reading media duration took too long. Try a supported MP4, MOV or WebM video, or an MP3, M4A, WAV or OGG recording.')), 20000);
    const cleanup = () => {
      media.onloadedmetadata = null;
      media.onerror = null;
      media.onabort = null;
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
      window.clearTimeout(timer);
    };
    const finish = (error?: Error, duration?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Could not read the media duration. Check that the selected file contains a playable audio track.'));
    };
    media.onloadedmetadata = () => finish(undefined, media.duration);
    media.onerror = () => finish(new Error('This device could not read the selected media metadata. Try MP4, MOV or WebM for video, or MP3, M4A, WAV or OGG for audio.'));
    media.onabort = () => finish(new Error('Reading media metadata was interrupted. Please select the file again.'));
    media.src = url;
  });
}


  const cleaned = value.trim().replace(/\\.[a-z0-9]{1,8}$/i, '').replace(/[\\/:*?"<>|\\u0000-\\u001f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 100);
  return cleaned || fallback;
}

async function downloadFile(name: string, content: string | Blob, type: string): Promise<void> {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  if (Capacitor.isNativePlatform()) {
    // Android WebView does not reliably honour <a download>. Save into app cache
    // and open the native share sheet so users can save to Downloads/Drive/etc.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    const saved = await Filesystem.writeFile({
      path: name,
      data: btoa(binary),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({
      title: name,
      text: 'Exported from AURORA VoiceText',
      files: [saved.uri],
      dialogTitle: 'Save or share your AURORA export',
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function normalizeTranscriptForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function subtitleToSrt(value: string): string {
  return normalizeSubtitleText(value, 'srt');
}

function subtitleToVtt(value: string): string {
  return normalizeSubtitleText(value, 'vtt');
}

function makeSummary(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
  if (!sentences.length) return '';
  const ranked = sentences.map((sentence, index) => ({
    sentence, index,
    score: (sentence.split(/\s+/).length > 4 ? 1 : 0) +
      (sentence.match(/\b(?:need|must|please|tomorrow|today|meeting|remember|send|call|pay|deadline|important|decide|agree|follow)\b/gi) || []).length * 2,
  }));
  return ranked.sort((a, b) => b.score - a.score).slice(0, Math.min(4, ranked.length)).sort((a, b) => a.index - b.index).map(item => '• ' + item.sentence).join('\n');
}


async function cacheVoskModel(onProgress?: (message: string) => void): Promise<void> {
  if (!('caches' in window)) throw new Error('This device does not support persistent model storage. Vosk cannot be prepared for offline use here.');
  const cache = await caches.open(VOSK_MODEL_CACHE_NAME);
  const key = new Request(VOSK_MODEL_CACHE_KEY);
  const existing = await cache.match(key);
  if (existing) {
    const cachedBlob = await existing.blob();
    const cachedHeader = new Uint8Array(await cachedBlob.slice(0, 2).arrayBuffer());
    if (cachedBlob.size > 5_000_000 && cachedHeader[0] === 0x1f && cachedHeader[1] === 0x8b) {
      onProgress?.('Vosk backup model is already saved on this device.');
      return;
    }
    // A truncated or non-gzip cache entry must not block future preparation attempts.
    await cache.delete(key);
  }

  onProgress?.('Downloading Vosk small English model · about 41 MB…');
  const response = await fetch(VOSK_MODEL_URL, { mode: 'cors' });
  if (!response.ok || response.type === 'opaque') {
    throw new Error('Could not download the Vosk model. Check your connection and try again.');
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  let blob: Blob;
  if (reader) {
    const chunks: BlobPart[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunkBuffer = new ArrayBuffer(value.byteLength);
        new Uint8Array(chunkBuffer).set(value);
        chunks.push(chunkBuffer);
        received += value.length;
        if (total > 0) onProgress?.('Downloading Vosk model · ' + Math.min(100, Math.round(received / total * 100)) + '%');
      }
    }
    blob = new Blob(chunks, { type: 'application/gzip' });
  } else {
    blob = await response.blob();
  }
  const archiveHeader = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (blob.size < 5_000_000 || archiveHeader[0] !== 0x1f || archiveHeader[1] !== 0x8b) {
    throw new Error('The Vosk model download is incomplete or is not a valid gzip archive. Please retry preparation.');
  }
  await cache.put(key, new Response(blob, {
    headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(blob.size) }
  }));
  onProgress?.('Vosk backup model saved on this device.');
}

async function getVoskModel(): Promise<any> {
  if (!voskModelPromise) {
    voskModelPromise = (async () => {
      if (!('caches' in window)) throw new Error('Persistent model storage is unavailable.');
      const cache = await caches.open(VOSK_MODEL_CACHE_NAME);
      const cached = await cache.match(new Request(VOSK_MODEL_CACHE_KEY));
      if (!cached) throw new Error('Vosk model is not prepared yet. Connect to the internet and tap Prepare offline engine.');
      const modelBlob = await cached.blob();
      if (modelBlob.size < 5_000_000) throw new Error('The saved Vosk model is incomplete. Prepare the offline engine again.');
      const modelUrl = URL.createObjectURL(modelBlob);
      try {
        const vosk = await import('vosk-browser');
        return await vosk.createModel(modelUrl);
      } catch (error) {
        // Remove a cached archive that cannot be opened so Prepare offline engine can
        // fetch a clean copy instead of repeatedly reusing a broken model.
        await cache.delete(new Request(VOSK_MODEL_CACHE_KEY)).catch(() => false);
        throw error;
      } finally {
        URL.revokeObjectURL(modelUrl);
      }
    })().catch(error => { voskModelPromise = null; throw error; });
  }
  return voskModelPromise;
}

async function verifyVoskEngine(): Promise<void> {
  const model = await getVoskModel();
  let recognizer: { remove: () => void } | null = null;
  try {
    // Validate the WASM recognizer constructor with the required numeric sample rate.
    recognizer = new model.KaldiRecognizer(16000);
  } finally {
    try { recognizer?.remove(); } catch { /* Model termination below also releases recognizers. */ }
    try { model.terminate(); } catch { /* Release the temporary verification worker. */ }
    voskModelPromise = null;
  }
}

async function transcribeWithVosk(audio: Float32Array): Promise<string> {
  const model = await getVoskModel();
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext is unavailable.');
  // vosk-browser's KaldiRecognizer constructor requires a numeric sample rate.
  // Omitting it causes the exact "Cannot convert undefined to float" WASM error.
  const context = new AudioContextClass({ sampleRate: 16000 });
  const sampleRate = Number(context.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    await context.close().catch(() => undefined);
    throw new Error('The device did not provide a valid audio sample rate for Vosk.');
  }
  const recognizer = new model.KaldiRecognizer(sampleRate);
  try {
    const buffer = context.createBuffer(1, audio.length, sampleRate);
    const channelData = new Float32Array(audio.length);
    channelData.set(audio);
    buffer.copyToChannel(channelData, 0);
    const transcript = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let quietTimer: number | undefined;
      const results: string[] = [];
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(maxTimer);
        if (quietTimer !== undefined) window.clearTimeout(quietTimer);
        const value = results.join(' ').replace(/\s+/g, ' ').trim();
        error ? reject(error) : resolve(value);
      };
      // Vosk runs on-device and can be slower than real time on entry-level
      // Android phones. Give each section a bounded, audio-length-aware window.
      const maxWaitMs = Math.min(120000, Math.max(30000, Math.ceil(audio.length / 16000 * 2500)));
      const maxTimer = window.setTimeout(() => finish(), maxWaitMs);
      recognizer.on('result', (message: any) => {
        const text = String(message?.result?.text || '').trim();
        if (text) results.push(text);
        if (quietTimer !== undefined) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => finish(), 900);
      });
      recognizer.on('error', (message: any) => finish(new Error(message?.error || 'Vosk recognition failed.')));
      try {
        recognizer.acceptWaveform(buffer);
        if (typeof recognizer.retrieveFinalResult === 'function') recognizer.retrieveFinalResult();
        else window.setTimeout(() => finish(), 6000);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (!transcript) throw new Error('Vosk returned no speech. Try a clearer recording or use Whisper Tiny.');
    return transcript;
  } finally {
    recognizer.remove();
    await context.close().catch(() => undefined);
  }
}
async function getWhisper(onProgress: (message: string) => void): Promise<Engine> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
      // A single WASM thread is slower on some devices but avoids fragile
      // multi-thread initialization in Android WebView and low-memory phones.
      if (transformers.env.backends.onnx.wasm) {
        transformers.env.backends.onnx.wasm.numThreads = 1;
      }
      const model = await transformers.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') onProgress('Downloading speech model… ' + Math.round(info.progress) + '%');
          if (info.status === 'done') onProgress('Speech model downloaded.');
        },
      });
      return model as unknown as Engine;
    })().catch(error => { pipelinePromise = null; throw error; });
  }
  return pipelinePromise;
}

async function getCachedOfflineAssetUrl(url: string, mime: string): Promise<string> {
  if ('caches' in window) {
    const cache = await caches.open('aurora-voicetext-offline-assets-v1');
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error('Could not download the offline audio decoder. Connect to the internet once, then tap Prepare offline engine.');
      await cache.put(url, response.clone());
    }
    return URL.createObjectURL(await response.blob());
  }
  return toBlobURL(url, mime);
}

async function transcribeOpusOfflineInSegments(
  file: File,
  onProgress: (completed: number, total: number) => void,
  onPart: (parts: string[]) => void,
  onTimedParts: (segments: TimedSegment[]) => void,
  onStatus: (message: string) => void,
  durationOverrideSeconds?: number,
  signal?: AbortSignal,
  nativeAudioPath?: string,
  nativeAudioSize?: number,
  nativeFingerprint?: string,
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const useNativeDecoder = Capacitor.isNativePlatform() && Boolean(nativeAudioPath);
  const useNativeSpeech = Capacitor.isNativePlatform() && Boolean(nativeAudioPath);
  const cancelNativeSpeech = () => { if (useNativeSpeech) void nativeSpeech.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelNativeSpeech, { once: true });
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const inputPath = '/audio-input/' + safeAudioInputName(file.name);
  const outputName = 'aurora-offline-current.wav';
  const parts: string[] = [];
  let timedSegments: TimedSegment[] = [];
  const defaultSegmentSeconds = Math.min(60, getAudioSegmentSeconds('offline'));
  const overlapSeconds = 2;
  let offlineCoreUrl = '';
  let offlineWasmUrl = '';
  const pcmToFloat = (bytes: Uint8Array): Float32Array => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12, dataStart = -1, dataLength = 0;
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') { dataStart = offset + 8; dataLength = Math.min(size, bytes.length - dataStart); break; }
      if (size > bytes.length - offset - 8) break;
      offset += 8 + size + (size % 2);
    }
    if (dataStart < 0 || dataLength < 2) throw new Error('The offline decoder produced an invalid PCM audio section.');
    const audio = new Float32Array(Math.floor(dataLength / 2));
    for (let i = 0; i < audio.length; i++) audio[i] = view.getInt16(dataStart + i * 2, true) / 32768;
    return audio;
  };
  try {
    if (useNativeDecoder) {
      onStatus('Using Android MediaCodec to decode audio sections…');
    } else {
      onStatus('Loading on-device audio decoder…');
      offlineCoreUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.js', 'text/javascript');
      offlineWasmUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.wasm', 'application/wasm');
      await ffmpeg.load({ coreURL: offlineCoreUrl, wasmURL: offlineWasmUrl });
      URL.revokeObjectURL(offlineCoreUrl); offlineCoreUrl = '';
      URL.revokeObjectURL(offlineWasmUrl); offlineWasmUrl = '';
      // Create the mount point before attaching the selected File to FFmpeg's virtual filesystem.
      await ffmpeg.createDir('/audio-input');
      const mountedFile = new File([file], safeAudioInputName(file.name), { type: file.type || 'application/octet-stream', lastModified: file.lastModified });
      const mounted = await ffmpeg.mount(FFFSType.WORKERFS, { files: [mountedFile] }, '/audio-input');
      if (!mounted) throw new Error('This browser could not mount the audio file for section-by-section processing. Try Chrome or a smaller MP3/WAV recording.');
    }
    const duration = Number.isFinite(durationOverrideSeconds) && (durationOverrideSeconds as number) > 0
      ? durationOverrideSeconds as number
      : await getAudioDurationSeconds(file);
    const fileKey = await makeAudioFileKey(file, nativeAudioPath, nativeAudioSize, nativeFingerprint);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey + '|offline'); } catch { /* Continue without persistent resume. */ }
    // Reuse the original section size on resume if device capability detection changes.
    const segmentSeconds = saved?.mode === 'offline' && Number.isFinite(saved.segmentSeconds) && (saved.segmentSeconds as number) >= 15
      ? saved.segmentSeconds as number : defaultSegmentSeconds;
    const stepSeconds = Math.max(1, segmentSeconds - overlapSeconds);
    const total = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!total || total > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const checkpoint: TranscriptionCheckpoint = isUsableCheckpoint(saved, fileKey, total, 'offline', segmentSeconds, overlapSeconds)
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, mode: 'offline', segmentSeconds, overlapSeconds, parts: [], nextChunk: 0, totalChunks: total };
    parts.push(...checkpoint.parts);
    timedSegments = [...(checkpoint.segments ?? [])];
    onPart(parts.filter(Boolean));
    onTimedParts(timedSegments);
    onProgress(checkpoint.nextChunk, total);
    let checkpointStorageWarningShown = false;
    for (let index = checkpoint.nextChunk; index < total; index++) {
      throwIfTranscriptionAborted(signal);
      const start = index * stepSeconds;
      const length = Math.min(segmentSeconds, duration - start);
      onStatus('Preparing offline section ' + (index + 1) + ' of ' + total + '…');
      let transcript = '';
      let whisperProblem = '';
      if (useNativeSpeech && nativeAudioPath) {
        try {
          onStatus('Native Android speech recognition · section ' + (index + 1) + ' of ' + total + '…');
          const nativeResult = await nativeSpeech.transcribeSegment({ path: nativeAudioPath, startSeconds: start, durationSeconds: length });
          transcript = nativeResult.text?.trim() || '';
          const nativeSegments = (nativeResult.words ?? []).map(word => {
            if (!word.word?.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) return null;
            if (index > 0 && word.start < overlapSeconds) return null;
            return { start: start + word.start, end: start + word.end, text: word.word.trim() };
          }).filter((segment): segment is TimedSegment => segment !== null);
          timedSegments.push(...nativeSegments);
          if (!transcript) whisperProblem = 'Native Vosk returned no speech text.';
        } catch (reason) {
          throwIfTranscriptionAborted(signal);
          whisperProblem = 'Native Vosk: ' + (reason instanceof Error ? reason.message : String(reason));
        }
      }
      if (!transcript) {
        if (useNativeSpeech) await nativeSpeech.releaseModel().catch(() => undefined);
        let decodedWav: Uint8Array;
        if (useNativeDecoder && nativeAudioPath) {
          const decoded = await nativeAudioFiles.decodeSegment({ path: nativeAudioPath, startSeconds: start, durationSeconds: length });
          const binary = atob(decoded.wavBase64);
          decodedWav = new Uint8Array(binary.length);
          for (let byte = 0; byte < binary.length; byte++) decodedWav[byte] = binary.charCodeAt(byte);
        } else {
          const decodeExitCode = await ffmpeg.exec([
            '-y', '-ss', String(start), '-t', String(length), '-i', inputPath,
            '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
            '-f', 'wav', outputName,
          ]);
          if (decodeExitCode !== 0) throw new Error('FFmpeg could not decode offline section ' + (index + 1) + ' (exit ' + decodeExitCode + '). Check the audio format or try MP3.');
          const output = await ffmpeg.readFile(outputName);
          if (typeof output === 'string') throw new Error('The offline decoder returned invalid audio data.');
          decodedWav = output;
        }
        const audio = pcmToFloat(decodedWav);
        if (audioRms(audio) < 0.0015) {
          parts.push('');
        } else {
          try {
            onStatus('On-device Whisper · section ' + (index + 1) + ' of ' + total + '…');
            const whisper = await getWhisper(onStatus);
            const result = await whisper(audio, { sampling_rate: 16000, chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
            transcript = result.text?.trim() || '';
            if (!transcript) throw new Error('Whisper Tiny returned an empty result.');
            const sectionSegments = (result.chunks ?? []).map(chunk => {
              const startTime = chunk.timestamp?.[0];
              const endTime = chunk.timestamp?.[1] ?? (index === total - 1 ? audio.length / 16000 : null);
              if (typeof startTime !== 'number' || typeof endTime !== 'number' || endTime <= startTime || !chunk.text?.trim()) return null;
              if (index > 0 && startTime < overlapSeconds) return null;
              return { start: start + startTime, end: start + endTime, text: chunk.text.trim() };
            }).filter((segment): segment is TimedSegment => segment !== null);
            timedSegments.push(...sectionSegments);
          } catch (reason) {
            const detail = reason instanceof Error ? reason.message : String(reason);
            whisperProblem = [whisperProblem, 'Whisper: ' + detail].filter(Boolean).join(' ');
          }
          if (!transcript) {
            try {
              onStatus('Browser Vosk fallback · section ' + (index + 1) + ' of ' + total + '…');
              transcript = await transcribeWithVosk(audio);
            } catch (voskProblem) {
              throw new Error('Offline engines could not transcribe section ' + (index + 1) + '. ' + whisperProblem + ' Browser Vosk: ' + (voskProblem instanceof Error ? voskProblem.message : String(voskProblem)));
            }
          }
          parts.push(transcript);
        }
      } else {
        parts.push(transcript);
      }
      checkpoint.parts = parts;
      checkpoint.segments = timedSegments;
      checkpoint.nextChunk = index + 1;
      try {
        await writeSavedCheckpoint(fileKey + '|offline', checkpoint);
      } catch {
        if (!checkpointStorageWarningShown) {
          checkpointStorageWarningShown = true;
          onStatus('Section ' + (index + 1) + ' is complete, but this device could not save its resume checkpoint. Keep AURORA open until transcription finishes.');
        }
      }
      onProgress(index + 1, total);
      onPart(parts.filter(Boolean));
      onTimedParts(timedSegments);
      if (!useNativeDecoder) {
        try { await ffmpeg.deleteFile(outputName); } catch { /* The next write replaces this temporary file. */ }
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (!parts.some(Boolean)) throw new Error('No clear speech was detected in this recording.');
    try { await removeSavedCheckpoint(fileKey + '|offline'); } catch { /* Transcript is already available. */ }
    return parts.filter(Boolean);
  } finally {
    if (offlineCoreUrl) URL.revokeObjectURL(offlineCoreUrl);
    if (offlineWasmUrl) URL.revokeObjectURL(offlineWasmUrl);
    signal?.removeEventListener('abort', cancelNativeSpeech);
    if (useNativeSpeech) await nativeSpeech.releaseModel().catch(() => undefined);
    try { await ffmpeg.deleteFile(outputName); } catch { /* Ignore absent temporary output. */ }
    try { await ffmpeg.unmount('/audio-input'); } catch { /* Decoder termination releases the mount. */ }
    ffmpeg.terminate();
  }
}

async function transcribeOpusInSegments(
  file: File,
  onProgress: (completed: number, total: number) => void,
  onPart: (parts: string[]) => void,
  onTimedParts: (segments: TimedSegment[]) => void,
  onStatus: (message: string) => void,
  onLanguage: (language: string) => void,
  durationOverrideSeconds?: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const inputPath = '/audio-input/' + safeAudioInputName(file.name);
  const outputName = 'aurora-online-current.mp3';
  let onlineCoreUrl = '';
  let onlineWasmUrl = '';
  const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  };
  try {
    onlineCoreUrl = await toBlobURL(coreBase + '/ffmpeg-core.js', 'text/javascript');
    onlineWasmUrl = await toBlobURL(coreBase + '/ffmpeg-core.wasm', 'application/wasm');
    await ffmpeg.load({ coreURL: onlineCoreUrl, wasmURL: onlineWasmUrl });
    URL.revokeObjectURL(onlineCoreUrl); onlineCoreUrl = '';
    URL.revokeObjectURL(onlineWasmUrl); onlineWasmUrl = '';
    // Create the mount point before attaching the selected File to FFmpeg's virtual filesystem.
    await ffmpeg.createDir('/audio-input');
    const mountedFile = new File([file], safeAudioInputName(file.name), { type: file.type || 'application/octet-stream', lastModified: file.lastModified });
    const mounted = await ffmpeg.mount(FFFSType.WORKERFS, { files: [mountedFile] }, '/audio-input');
    if (!mounted) throw new Error('This browser could not mount the audio file for section-by-section processing. Try Chrome or a smaller MP3/WAV recording.');
    const duration = Number.isFinite(durationOverrideSeconds) && (durationOverrideSeconds as number) > 0
      ? durationOverrideSeconds as number
      : await getAudioDurationSeconds(file);
    const defaultSegmentSeconds = Math.min(90, getAudioSegmentSeconds('online')); // Keep Android Go working sets modest.
    const overlapSeconds = 2;
    const fileKey = await makeAudioFileKey(file);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey + '|online'); } catch { /* Continue without persistent resume. */ }
    const segmentSeconds = saved?.mode === 'online' && Number.isFinite(saved.segmentSeconds) && (saved.segmentSeconds as number) >= 15
      ? saved.segmentSeconds as number : defaultSegmentSeconds;
    const stepSeconds = Math.max(1, segmentSeconds - overlapSeconds);
    const totalParts = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!totalParts || totalParts > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const checkpoint: TranscriptionCheckpoint = isUsableCheckpoint(saved, fileKey, totalParts, 'online', segmentSeconds, overlapSeconds)
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, mode: 'online', segmentSeconds, overlapSeconds, parts: [], nextChunk: 0, totalChunks: totalParts };
    const parts: string[] = [...checkpoint.parts];
    const timedSegments: TimedSegment[] = [...(checkpoint.segments ?? [])];
    onPart(parts);
    onTimedParts(timedSegments);
    onProgress(checkpoint.nextChunk, totalParts);
    // Encode and upload one section at a time because FFmpeg shares one virtual output file.
    // Sequential requests also cap peak memory and make each completed section resumable.
    const uploadPrepared = async (prepared: { index: number; start: number; bytes: Uint8Array }) => {
      const payload = JSON.stringify({
        audioBase64: toBase64(prepared.bytes),
        mimeType: 'audio/mpeg',
        chunkNumber: prepared.index + 1,
        totalChunks: totalParts,
        detectLanguage: true,
        speakerLabels: true,
      });
      // Transcription POSTs are not safe to retry blindly: a timed-out
      // request may still be processing and could create duplicate provider jobs.
      // Try the primary once, then hand off to the independent Worker once.
      const request = (url: string) => postJson(url, JSON.parse(payload), 120000, signal);
      let response: Response;
      try {
        response = await request(transcriptionApiUrl);
      } catch (primaryNetworkError) {
        throwIfTranscriptionAborted(signal);
        if (!backupTranscriptionApiUrl) throw primaryNetworkError;
        response = await request(backupTranscriptionApiUrl);
      }
      let primaryFailure = '';
      throwIfTranscriptionAborted(signal);
      if (!response.ok && backupTranscriptionApiUrl &&
          ([408, 425, 429].includes(response.status) || response.status >= 500)) {
        const primaryPayload = await response.clone().json().catch(() => ({})) as { error?: string };
        primaryFailure = primaryPayload.error || 'Primary transcription service returned HTTP ' + response.status + '.';
        // The independent Worker is a separate host and is called only once.
        // Do not retry a request after a successful response or a permanent 4xx.
        response = await request(backupTranscriptionApiUrl);
      }
      throwIfTranscriptionAborted(signal);
      let result = await response.json().catch(() => ({})) as { text?: string; error?: string; language?: string; language_name?: string; segments?: Array<{ start?: number; end?: number; text?: string; speaker_id?: string; speaker?: string }> };
      if (!response.ok) throw new Error((result.error || 'Transcription failed on audio section ' + (prepared.index + 1) + '.') + (primaryFailure ? ' Primary service: ' + primaryFailure : ''));
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('The transcription service returned an empty result for audio section ' + (prepared.index + 1) + '.');
      return { index: prepared.index, start: prepared.start, text: result.text.trim(), language: result.language_name || result.language || '', segments: result.segments ?? [] };
    };

    let checkpointStorageWarningShown = false;
    for (let index = checkpoint.nextChunk; index < totalParts; index++) {
      throwIfTranscriptionAborted(signal);
      const start = index * stepSeconds;
      const length = Math.min(segmentSeconds, duration - start);
      const encodeExitCode = await ffmpeg.exec([
        '-y', '-ss', String(start), '-t', String(length), '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', outputName,
      ]);
      if (encodeExitCode !== 0) throw new Error('FFmpeg could not prepare online section ' + (index + 1) + ' (exit ' + encodeExitCode + '). Check the audio format or try MP3.');
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('The audio decoder returned invalid section data.');
      if (!output.length) throw new Error('The audio decoder created an empty section.');
      if (output.length > 1250000) throw new Error('Audio section ' + (index + 1) + ' is too large to upload safely. Reduce the section length and retry.');
      const prepared = { index, start, bytes: new Uint8Array(output) };
      try { await ffmpeg.deleteFile(outputName); } catch { /* Ignore absent temporary output. */ }

      // Process one section at a time: this limits peak memory on Android Go and
      // makes every completed section independently resumable after interruption.
      const result = await uploadPrepared(prepared);
      parts[index] = result.text;
      if (result.language) { onLanguage(result.language); onStatus('Detected language: ' + result.language + ' · section ' + (index + 1) + ' of ' + totalParts); }
      const sectionSegments = result.segments.filter(segment =>
        typeof segment.start === 'number' && typeof segment.end === 'number' &&
        typeof segment.text === 'string' && (result.index === 0 || segment.start >= overlapSeconds)
      ).map(segment => ({
        start: result.start + (segment.start as number),
        end: result.start + (segment.end as number),
        text: (segment.text as string).trim(),
        speaker: segment.speaker || segment.speaker_id || undefined,
      })).filter(segment => segment.text.length > 0);
      timedSegments.push(...sectionSegments);
      checkpoint.segments = timedSegments;
      checkpoint.parts = parts;
      checkpoint.nextChunk = index + 1;
      try {
        await writeSavedCheckpoint(fileKey + '|online', checkpoint);
      } catch {
        if (!checkpointStorageWarningShown) {
          checkpointStorageWarningShown = true;
          onStatus('Section ' + (index + 1) + ' is complete. This device could not save a resume checkpoint, so keep the app open until transcription finishes.');
        }
      }
      onProgress(index + 1, totalParts);
      onPart(parts.filter(Boolean));
      onTimedParts(timedSegments);
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (!parts.length) throw new Error('The audio decoder found no transcribable speech sections.');
    try { await removeSavedCheckpoint(fileKey + '|online'); } catch { /* Completed transcript is already available. */ }
    return parts;
  } finally {
    if (onlineCoreUrl) URL.revokeObjectURL(onlineCoreUrl);
    if (onlineWasmUrl) URL.revokeObjectURL(onlineWasmUrl);
    try { await ffmpeg.deleteFile(outputName); } catch { /* Ignore absent temporary output. */ }
    try { await ffmpeg.unmount('/audio-input'); } catch { /* Decoder termination releases the mount. */ }
    ffmpeg.terminate();
  }
}

function audioRms(audio: Float32Array): number {
  if (!audio.length) return 0;
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
  return Math.sqrt(sum / audio.length);
}

type AppSelectOption = { value: string; label: string; group?: string };
function AppSelect({ value, onChange, options, ariaLabel }: { value: string; onChange: (value: string) => void; options: AppSelectOption[]; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <div className="app-select">
    <button type="button" className="app-select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} onClick={() => setOpen(current => !current)}>
      <span>{selected?.label ?? 'Choose an option'}</span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    {open && <>
      <button type="button" className="app-select-dismiss" aria-label="Close options" onClick={() => setOpen(false)}/>
      <div className="app-select-menu" role="listbox" aria-label={ariaLabel}>
        {options.map((option, index) => <div key={option.value}>
          {option.group && (index === 0 || options[index - 1]?.group !== option.group) && <div className="app-select-group">{option.group}</div>}
          <button type="button" role="option" aria-selected={option.value === value} className={'app-select-option' + (option.value === value ? ' active' : '')} onClick={() => { onChange(option.value); setOpen(false); }}>
            <span>{option.label}</span>{option.value === value && <Check size={15}/>}
          </button>
        </div>)}
      </div>
    </>}
  </div>;
}

function App() {
  const [page, setPage] = useState<Page>('home');
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [library, setLibrary] = useState<Recording[]>(readLibrary);
  const [busy, setBusy] = useState(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<TranscriptionMode>('auto');
  const [offlinePrepBusy, setOfflinePrepBusy] = useState(false);
  const [offlinePrepStatus, setOfflinePrepStatus] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [savedCheckpoint, setSavedCheckpoint] = useState<{ mode: 'online' | 'offline'; completed: number; total: number } | null>(null);
  const [checkingSavedCheckpoint, setCheckingSavedCheckpoint] = useState(false);
  const [error, setError] = useState('');
  const [transcriptionFailed, setTranscriptionFailed] = useState(false);
  const [exportType, setExportType] = useState('docx');
  const [exportTemplate, setExportTemplate] = useState('standard');
  const [exportFilename, setExportFilename] = useState('');
  const [voiceFilename, setVoiceFilename] = useState('aurora-voice');
  const [studioText, setStudioText] = useState('');
  const [voiceChatInput, setVoiceChatInput] = useState('');
  const [voiceChatMessages, setVoiceChatMessages] = useState<Array<{id:string;role:'user'|'assistant';text:string}>>([]);
  const [voiceMentionOpen, setVoiceMentionOpen] = useState(false);
  const [voiceMentionQuery, setVoiceMentionQuery] = useState('');
  const voiceAttachmentRef = useRef<HTMLInputElement>(null);
  const [voiceRate, setVoiceRate] = useState(1);
  const [voicePitch, setVoicePitch] = useState(1);
  const [voiceName, setVoiceName] = useState('nova');
  const [voiceStyle, setVoiceStyle] = useState('Natural, conversational delivery');
  const [voiceEmotion, setVoiceEmotion] = useState('Warm and friendly');
  const [voiceAccent, setVoiceAccent] = useState('International English');
  const [voiceLanguage, setVoiceLanguage] = useState('Auto-detect');
  const [voiceEmphasis, setVoiceEmphasis] = useState('Natural emphasis');
  const [voicePauses, setVoicePauses] = useState('Natural pauses');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceAudioUrl, setVoiceAudioUrl] = useState('');
  const [audioPlayhead, setAudioPlayhead] = useState(0);
  const [editorStart, setEditorStart] = useState(0);
  const [editorEnd, setEditorEnd] = useState(0);
  const [editorDuration, setEditorDuration] = useState(0);
  const [editorBusy, setEditorBusy] = useState(false);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [subtitleQuery, setSubtitleQuery] = useState('');
  const [subtitleLanguage, setSubtitleLanguage] = useState('en');
  const [subtitleType, setSubtitleType] = useState<'movie' | 'episode' | undefined>(undefined);
  const [subtitleResults, setSubtitleResults] = useState<Array<{id:string;fileId:number|null;fileName:string;language:string;release:string;title:string;year:number|null;season?:number|null;episode?:number|null;hearingImpaired?:boolean;downloads:number}>>([]);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [subtitleTranslateLanguage, setSubtitleTranslateLanguage] = useState('English');
  const [transcriptTargetLanguage, setTranscriptTargetLanguage] = useState('English');
  const [previewMessages, setPreviewMessages] = useState<PreviewMessage[]>([]);
  const [previewInput, setPreviewInput] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [subtitleStatus, setSubtitleStatus] = useState('');
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleFilename, setSubtitleFilename] = useState('subtitle');
  const audioRef = useRef<HTMLAudioElement>(null);
  const [summary, setSummary] = useState('');
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const libraryImportRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<AudioFile[]>(files);
  filesRef.current = files;
  const active = files.find(item => item.id === activeId) ?? files[0] ?? null;

  // Surface resumable work as soon as the same recording is selected again.
  useEffect(() => {
    if (!active) { setSavedCheckpoint(null); setCheckingSavedCheckpoint(false); return; }
    let cancelled = false;
    setSavedCheckpoint(null);
    setCheckingSavedCheckpoint(true);
    void (async () => {
      try {
        const duration = active.nativeDurationMs && active.nativeDurationMs > 0
          ? active.nativeDurationMs / 1000
          : await getAudioDurationSeconds(active.file);
        const fileKey = await makeAudioFileKey(active.file, active.nativePath, active.nativeSize, active.nativeFingerprint);
        const candidates = await Promise.all((['online', 'offline'] as const).map(async mode => {
          try {
            const saved = await readSavedCheckpoint(fileKey + '|' + mode);
            if (!saved || saved.mode !== mode || !Number.isFinite(saved.segmentSeconds) || saved.segmentSeconds <= saved.overlapSeconds) return null;
            const stepSeconds = Math.max(1, saved.segmentSeconds - saved.overlapSeconds);
            const total = Math.max(1, Math.ceil((duration - saved.overlapSeconds) / stepSeconds));
            if (!isUsableCheckpoint(saved, fileKey, total, mode, saved.segmentSeconds, saved.overlapSeconds)) return null;
            if (saved.nextChunk <= 0 || saved.nextChunk >= total) return null;
            return { mode, completed: saved.nextChunk, total };
          } catch { return null; }
        }));
        if (cancelled) return;
        const resumable = candidates.filter((item): item is NonNullable<typeof item> => item !== null)
          .sort((a, b) => (b.completed / b.total) - (a.completed / a.total))[0] ?? null;
        setSavedCheckpoint(resumable);
      } catch {
        if (!cancelled) setSavedCheckpoint(null);
      } finally {
        if (!cancelled) setCheckingSavedCheckpoint(false);
      }
    })();
    return () => { cancelled = true; };
  }, [active?.id, active?.file, active?.nativePath, active?.nativeSize, active?.nativeDurationMs, active?.nativeFingerprint]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); } catch { /* Browser storage can be full or disabled. */ }
  }, [library]);

  useEffect(() => {
    void pruneSavedCheckpoints().catch(() => {
      // Checkpoint cleanup is best-effort; saved transcripts remain untouched.
    });
  }, []);

  // Keep Android's display awake during an active foreground transcription.
  // This does not keep JavaScript running after Android backgrounds or force-stops the app.
  useEffect(() => {
    if (!busy || !('wakeLock' in navigator)) return;
    let cancelled = false;
    let lock: { release: () => Promise<void> } | null = null;
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    wakeLock?.request('screen').then(value => {
      if (cancelled) void value.release();
      else lock = value;
    }).catch(() => { /* Wake Lock is optional; transcription still proceeds. */ });
    return () => {
      cancelled = true;
      if (lock) void lock.release();
    };
  }, [busy]);

  useEffect(() => () => filesRef.current.forEach(item => URL.revokeObjectURL(item.url)), []);

  async function pickNativeAudioFiles() {
    if (!Capacitor.isNativePlatform()) { inputRef.current?.click(); return; }
    setError('');
    try {
      const result = await nativeAudioFiles.pick();
      const imported: File[] = [];
      const nativeDetails: Array<{ path?: string; size?: number; durationMs?: number; contentHash?: string; audioInfo?: NativeAudioDetails }> = [];
      for (const item of result.files || []) {
        // Keep Android imports on disk. The native offline decoder reads bounded sections
        // directly, avoiding a second full-size audio Blob in low-memory WebViews.
        imported.push(new File([], item.name, { type: item.mimeType || 'application/octet-stream', lastModified: Date.now() }));
        nativeDetails.push({ path: item.path, size: item.size, durationMs: item.durationMs, contentHash: item.contentHash, audioInfo: item.audioInfo });
      }
      addFiles(imported, nativeDetails);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!/cancel|cancelled|canceled/i.test(message)) setError(message || 'Android audio import failed.');
    }
  }

  async function loadNativeAudioForOnline(item: AudioFile): Promise<File> {
    if (!item.nativePath) return item.file;
    setStatus('Loading audio for online section processing…');
    const response = await fetch(Capacitor.convertFileSrc(item.nativePath));
    if (!response.ok) throw new Error('Android could not read ' + item.file.name + ' from private storage.');
    const blob = await response.blob();
    if (item.nativeSize && blob.size !== item.nativeSize) {
      throw new Error('The imported audio copy is incomplete. Re-import the recording before transcribing.');
    }
    return new File([blob], item.file.name, { type: item.file.type || blob.type || 'application/octet-stream', lastModified: item.file.lastModified });
  }

  function addFiles(list: FileList | File[] | null, nativeDetails?: Array<{ path?: string; size?: number; durationMs?: number; contentHash?: string; audioInfo?: NativeAudioDetails }>) {
    if (!list) return;
    const incoming = Array.from(list);
    const accepted = incoming.map((file, index) => ({ file, index })).filter(({ file, index }) => {
      const nativeItem = nativeDetails?.[index];
      const hasAudioBytes = file.size > 0 || Boolean(nativeItem?.path && (nativeItem.size ?? 0) > 0);
      return hasAudioBytes && (file.type.startsWith('audio/') || isVideoMediaFile(file) || /\.(opus|ogg|mp3|m4a|wav|aac|amr|3gp|webm)$/i.test(file.name));
    });
    if (!accepted.length) { setError('Choose an audio recording or a video containing an audio track.'); return; }
    const next = accepted.map(({ file, index }) => {
      const nativePath = nativeDetails?.[index]?.path;
      return { id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), file, url: nativePath ? Capacitor.convertFileSrc(nativePath) : URL.createObjectURL(file), transcript: '', nativePath, nativeSize: nativeDetails?.[index]?.size, nativeDurationMs: nativeDetails?.[index]?.durationMs, nativeFingerprint: nativeDetails?.[index]?.contentHash, nativeAudioInfo: nativeDetails?.[index]?.audioInfo };
    });
    setFiles(current => [...current, ...next]);
    setActiveId(current => current ?? next[0].id);
    setError('');
  }


  async function prepareOfflineEngine() {
    if (offlinePrepBusy) return;
    setOfflinePrepBusy(true); setOfflinePrepStatus('Getting offline transcription ready…'); setError('');
    const failures: string[] = [];
    const describe = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

    // Android uses the real native Vosk runtime and keeps the PWA's browser Vosk engine separate.
    if (Capacitor.isNativePlatform()) {
      try {
        setOfflinePrepStatus('Downloading the native English speech model (about 40 MB)…');
        await nativeSpeech.prepareModel();
        setOfflinePrepStatus('Native Android Vosk speech model is installed and initialized.');
      } catch (reason) {
        failures.push('Native Android Vosk: ' + describe(reason));
      }
    } else {
      try {
        await cacheVoskModel(() => setOfflinePrepStatus('Preparing offline transcription…'));
        setOfflinePrepStatus('Preparing offline transcription…');
        await verifyVoskEngine();
        setOfflinePrepStatus('Browser Vosk model and recognizer passed initialization.');
      } catch (reason) {
        failures.push('Browser Vosk backup: ' + describe(reason));
      }
    }

    // The Android APK decodes audio with MediaCodec and must not depend on a
    // browser/WASM decoder CDN to prepare its native offline speech engine.
    if (!Capacitor.isNativePlatform()) {
      try {
        const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
        setOfflinePrepStatus('Preparing offline audio decoder…');
        const coreUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.js', 'text/javascript');
        const wasmUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.wasm', 'application/wasm');
        const ffmpeg = new FFmpeg();
        try {
          await ffmpeg.load({ coreURL: coreUrl, wasmURL: wasmUrl });
          setOfflinePrepStatus('Browser FFmpeg WASM decoder passed initialization.');
        } finally {
          ffmpeg.terminate();
          URL.revokeObjectURL(coreUrl);
          URL.revokeObjectURL(wasmUrl);
        }
      } catch (reason) {
        failures.push('Browser audio decoder: ' + describe(reason));
      }
    }

    // Keep the native Vosk model separate from the browser Whisper model on Android.
    if (!Capacitor.isNativePlatform()) {
      try {
        setOfflinePrepStatus('Preparing offline transcription…');
        await getWhisper(() => setOfflinePrepStatus('Preparing offline transcription…'));
        setOfflinePrepStatus('Preparing offline transcription…');
      } catch (reason) {
        failures.push('Whisper Tiny: ' + describe(reason));
      }
    }

    if (failures.length) {
      setOfflinePrepStatus('Offline setup is not complete yet. Connect to the internet and try again.');
      setError('Offline setup details: ' + failures.join(' | ') + ' You can still use Auto or Online mode.');
    } else {
      setOfflinePrepStatus('Offline transcription is ready on this device.');
      setError('');
    }
    setOfflinePrepBusy(false);
  }


  async function transcribe() {
    if (!active || busy) return;
    const selected = active;
    const controller = new AbortController();
    transcriptionAbortRef.current = controller;
    setBusy(true);
    setTranscriptionFailed(false);
    setError('');
    setStatus('Preparing audio for section-by-section transcription…');
    setProgress({ completed: 0, total: 0 });
    const onPart = (parts: string[]) => {
      const partial = mergeTranscriptParts(parts);
      if (partial) setFiles(current => current.map(item => item.id === selected.id ? { ...item, transcript: partial } : item));
    };
    const onTimedParts = (segments: TimedSegment[]) => {
      setFiles(current => current.map(item => item.id === selected.id ? { ...item, timedSegments: segments } : item));
    };
    const onProgress = (completed: number, total: number, _engine: string) => {
      setProgress({ completed, total });
      const message = 'Transcribing section ' + completed + ' of ' + total;
      setStatus(message);
      if (Capacitor.isNativePlatform()) void backgroundTranscription.update({ message }).catch(() => undefined);
    };
    const runOffline = () => transcribeOpusOfflineInSegments(
      selected.file,
      (completed, total) => onProgress(completed, total, 'Transcription'),
      onPart,
      onTimedParts,
      () => setStatus('Preparing offline transcription…'),
      selected.nativeDurationMs && selected.nativeDurationMs > 0 ? selected.nativeDurationMs / 1000 : undefined,
      controller.signal,
      selected.nativePath,
      selected.nativeSize,
      selected.nativeFingerprint,
    );
    try {
      if (Capacitor.isNativePlatform()) await backgroundTranscription.start().catch(() => undefined);
      let parts: string[];
      if (mode === 'offline') {
        setStatus('Offline mode · audio stays on this device.');
        parts = await runOffline();
      } else {
        try {
          setStatus('Online mode · preparing upload-safe audio sections…');
          const onlineFile = selected.nativePath && selected.file.size === 0
            ? await loadNativeAudioForOnline(selected)
            : selected.file;
          parts = await transcribeOpusInSegments(
            onlineFile,
            (completed, total) => onProgress(completed, total, 'Online transcription'),
            onPart,
            onTimedParts,
            setStatus,
            language => setFiles(current => current.map(item => item.id === selected.id ? { ...item, detectedLanguage: language } : item)),
            selected.nativeDurationMs && selected.nativeDurationMs > 0 ? selected.nativeDurationMs / 1000 : undefined,
            controller.signal,
          );
        } catch (onlineProblem) {
          if (mode === 'online' || controller.signal.aborted) throw onlineProblem;
          setStatus('The online service is unavailable. Trying another available method…');
          try {
            parts = await runOffline();
          } catch (offlineProblem) {
            const onlineMessage = onlineProblem instanceof Error ? onlineProblem.message : String(onlineProblem);
            const offlineMessage = offlineProblem instanceof Error ? offlineProblem.message : String(offlineProblem);
            throw new Error('Online transcription failed: ' + onlineMessage + ' Offline fallback failed: ' + offlineMessage + ' Completed sections remain saved where device storage allows.');
          }
        }
      }
      const completedText = mergeTranscriptParts(parts);
      if (!completedText) throw new Error('No clear speech was detected. Try a recording with clearer speech and less background noise.');
      setFiles(current => current.map(item => item.id === selected.id ? { ...item, transcript: completedText, translatedTranscript: '' } : item));
      setStatus('Transcription complete. Your transcript is ready to review.');
      setError('');
      setTranscriptionFailed(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Transcription failed.';
      setTranscriptionFailed(true);
      setError(message);
      setStatus('Your recording remains selected. You can retry without starting over from completed sections.');
    } finally {
      if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null;
      if (Capacitor.isNativePlatform()) await backgroundTranscription.stop().catch(() => undefined);
      setBusy(false);
    }
  }
  async function translateText(text: string, targetLanguage: string): Promise<string> {
    const { data } = await requestFeature('/api/translate', { text, targetLanguage, sourceLanguage: active?.detectedLanguage || 'auto' });
    const translated = String(data?.text || '').trim();
    if (!translated) throw new Error('Translation could not be completed. Please try again.');
    return translated;
  }


  async function sendPreviewMessage() {
    const prompt = previewInput.trim();
    if (!prompt || previewBusy) return;
    if (!active?.transcript.trim()) { setError('Choose a transcript in Transcribe before using AI Preview.'); return; }
    const userMessage: PreviewMessage = { id: crypto.randomUUID?.() ?? String(Date.now()), role: 'user', text: prompt };
    setPreviewMessages(current => [...current, userMessage]); setPreviewInput(''); setPreviewBusy(true); setError('');
    try {
      const lower = prompt.toLowerCase();
      let result = '';
      const translateMatch = lower.match(/(?:translate|translation)\s+(?:this\s+)?(?:transcript\s+)?(?:to|into)\s+([a-z][a-z -]{1,30})/i) || lower.match(/(?:to|into)\s+([a-z][a-z -]{1,30})\s+please\s*$/i);
      if (translateMatch) {
        const target = translateMatch[1].trim().replace(/[.!?]+$/, '');
        result = await translateText(active.transcript, target);
        setFiles(current => current.map(item => item.id === active.id ? { ...item, translatedTranscript: result } : item));
        setTranscriptTargetLanguage(target);
        result = `Here is the transcript translated into ${target}:\n\n${result}`;
      } else if (/\b(summar|key points|main points|brief)\b/.test(lower)) {
        result = makeSummary(active.transcript) || 'There is not enough transcript text to summarize.';
      } else if (/\b(polish|clean up|proofread|correct grammar|fix grammar|punctuat)\b/.test(lower)) {
        const chunks = splitLongText(active.transcript, 18000); const output: string[] = [];
        for (const chunk of chunks) {
          const { data } = await requestFeature('/api/assist', { text: chunk });
          if (!data?.text) throw new Error('AI could not prepare the edited transcript.');
          output.push(String(data.text));
        }
        result = output.join('\n\n'); updateTranscript(result);
      } else {
        result = 'I can work with this transcript by translating it, polishing the wording, or creating a summary. Try a request such as “Translate this transcript to Yoruba”, “Polish the transcript”, or “Summarize the main points”.';
      }
      setPreviewMessages(current => [...current, { id: crypto.randomUUID?.() ?? String(Date.now()+1), role: 'assistant', text: result }]);
    } catch (reason) {
      setPreviewMessages(current => [...current, { id: crypto.randomUUID?.() ?? String(Date.now()+2), role: 'assistant', text: reason instanceof Error ? reason.message : 'That request could not be completed. Please try again.' }]);
    } finally { setPreviewBusy(false); }
  }

  function updateTranscript(text: string) {
    if (!active) return;
    setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: text } : item));
  }

  function saveToLibrary() {
    if (!active?.transcript.trim()) { setError('Add or transcribe some text before saving.'); return; }
    const record: Recording = { id: active.id, name: active.file.name, transcript: active.transcript.trim(), updatedAt: Date.now() };
    setLibrary(current => [record, ...current.filter(item => item.id !== record.id)]);
    setError(''); setStatus('Saved to your on-device library.');
  }

  async function exportLibraryBackup() {
    const payload = {
      format: 'aurora-voicetext-library',
      version: 1,
      exportedAt: new Date().toISOString(),
      recordings: library.map(item => ({
        id: item.id,
        name: item.name,
        transcript: item.transcript,
        updatedAt: item.updatedAt,
      })),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    await downloadFile('aurora-voicetext-library-' + stamp + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    setStatus('Library backup exported. Keep a copy somewhere safe.');
    setError('');
  }

  async function importLibraryBackup(file?: File) {
    if (!file) return;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('This backup is larger than 25 MB.');
      const parsed = JSON.parse(await file.text()) as { format?: unknown; version?: unknown; recordings?: unknown };
      if (parsed?.format !== 'aurora-voicetext-library' || parsed.version !== 1 || !Array.isArray(parsed.recordings)) {
        throw new Error('This is not a supported AURORA VoiceText library backup.');
      }
      if (parsed.recordings.length > 5000) throw new Error('This backup contains too many recordings.');
      const imported: Recording[] = [];
      for (const raw of parsed.recordings) {
        if (!raw || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (typeof item.name !== 'string' || typeof item.transcript !== 'string') continue;
        const name = item.name.trim().slice(0, 240);
        const transcript = item.transcript.slice(0, 5_000_000);
        if (!name || !transcript.trim()) continue;
        imported.push({
          id: typeof item.id === 'string' && item.id.length <= 160 ? item.id : crypto.randomUUID(),
          name,
          transcript,
          updatedAt: Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now(),
        });
      }
      if (!imported.length) throw new Error('No valid saved transcripts were found in this backup.');
      setLibrary(current => {
        const merged = new Map(current.map(item => [item.id, item]));
        for (const item of imported) {
          const existing = merged.get(item.id);
          if (!existing || item.updatedAt >= existing.updatedAt) merged.set(item.id, item);
        }
        return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      });
      setStatus(imported.length + ' transcript(s) imported or updated. Your existing library was kept.');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import this library backup.');
    } finally {
      if (libraryImportRef.current) libraryImportRef.current.value = '';
    }
  }

  function removeFile(id: string) {
    setFiles(current => {
      const removed = current.find(item => item.id === id);
      if (removed) URL.revokeObjectURL(removed.url);
      const next = current.filter(item => item.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  async function exportTranscript(text: string, baseName = 'aurora-voicetext-transcript', timedSegments?: TimedSegment[]) {
    if (!text.trim()) { setError('There is no transcript to export yet.'); return; }
    const fileBase = safeFileBaseName(exportFilename || baseName, 'aurora-voicetext-transcript');
    const documentTitle = safeFileBaseName(baseName, 'Transcript');
    const attribution = 'Transcribed by AURORA VoiceText';
    const templateLabel = exportTemplate === 'meeting' ? 'MEETING TRANSCRIPT' : exportTemplate === 'study' ? 'STUDY NOTES' : 'TRANSCRIPT';
    const templateSubtitle = exportTemplate === 'meeting' ? 'Meeting transcript' : exportTemplate === 'study' ? 'Study notes' : '';
    const segmentTranscript = timedSegments?.length ? timedSegments.map(segment => segment.text).join(' ') : '';
    const timestampsCoverTranscript = Boolean(timedSegments?.length) &&
      normalizeTranscriptForCompare(segmentTranscript) === normalizeTranscriptForCompare(text);
    const timestamped = includeTimestamps && timestampsCoverTranscript
      ? timedSegments!.map(segment => '[' + new Date(segment.start * 1000).toISOString().slice(11,19) + '] ' + segment.text).join('\n')
      : text;
    const transcriptDocument = documentTitle + '\n' + (templateSubtitle ? templateSubtitle + '\n' : '') + attribution + '\n\n' + timestamped;
    if (exportType === 'docx') {
      try {
        const paragraphs = includeTimestamps && timestampsCoverTranscript
          ? timedSegments!.map(segment => new Paragraph({ children: [new TextRun({ text: '[' + new Date(segment.start * 1000).toISOString().slice(11,19) + '] ', bold: true, color: '167D91' }), new TextRun(segment.text)], spacing: { after: 120 } }))
          : text.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun(line)], spacing: { after: 120 } }));
        const doc = new Document({ sections: [{ properties: {}, children: [
          new Paragraph({ children: [new TextRun({ text: templateLabel, bold: true, size: 18, color: '167D91', characterSpacing: 24 })], spacing: { after: 100 } }),
          new Paragraph({ children: [new TextRun({ text: documentTitle, bold: true, size: 34, color: '172033' })], spacing: { after: 100 } }),
          ...(templateSubtitle ? [new Paragraph({ children: [new TextRun({ text: templateSubtitle, color: '475569', size: 22 })], spacing: { after: 100 } })] : []),
          new Paragraph({ children: [new TextRun({ text: attribution, italics: true, color: '64748B', size: 20 })], spacing: { after: 360 } }),
          ...paragraphs
        ] }] });
        const blob = await Packer.toBlob(doc);
        await downloadFile(fileBase + '.docx', blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        setError('');
        setStatus(includeTimestamps && timedSegments?.length && !timestampsCoverTranscript
          ? 'DOCX exported with the complete transcript. Timestamps were omitted because the timed segments did not cover all edited text.'
          : 'DOCX document prepared with the complete transcript.');
      } catch (error) { setError(error instanceof Error ? error.message : 'DOCX export failed.'); }
      return;
    }
    if (exportType === 'pdf') {
      if (Capacitor.isNativePlatform()) {
        const { jsPDF } = await import('jspdf');
        const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
        const margin = 16;
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        let y = 20;
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10); pdf.setTextColor(22, 125, 145);
        pdf.text(templateLabel, margin, y); y += 10;
        pdf.setFontSize(19); pdf.setTextColor(23, 32, 51);
        const titleLines = pdf.splitTextToSize(documentTitle, pageWidth - margin * 2);
        pdf.text(titleLines, margin, y); y += titleLines.length * 8 + 3;
        if (templateSubtitle) { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(11); pdf.setTextColor(71, 85, 105); pdf.text(templateSubtitle, margin, y); y += 8; }
        pdf.setFontSize(9); pdf.setTextColor(100, 116, 139); pdf.text(attribution, margin, y); y += 10;
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10); pdf.setTextColor(25, 35, 50);
        const bodyLines = pdf.splitTextToSize(timestamped, pageWidth - margin * 2);
        for (const line of bodyLines) {
          if (y > pageHeight - margin) { pdf.addPage(); y = margin; }
          pdf.text(line, margin, y); y += 5.2;
        }
        await downloadFile(fileBase + '.pdf', pdf.output('blob'), 'application/pdf');
        setStatus('PDF created. Choose where to save or share it.');
        return;
      }
      const popup = window.open('', '_blank');
      if (!popup) { setError('Allow pop-ups to print or save as PDF.'); return; }
      popup.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + documentTitle.replace(/[&<>\"]/g, '') + '</title><style>body{font:16px/1.8 Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#172033}.kicker{font-size:10px;letter-spacing:2px;color:#167d91;font-weight:bold;margin:0 0 12px}h1{font-size:30px;line-height:1.2;margin:0 0 8px}.subtitle{font-size:15px;color:#475569;margin:0 0 8px}.byline{color:#64748b;font-size:11px;margin:0 0 26px;padding-bottom:18px;border-bottom:1px solid #dbe3eb}.transcript{white-space:pre-wrap}@media print{body{margin:18mm auto;padding:0}}</style></head><body><p class="kicker"></p><h1></h1><p class="subtitle"></p><p class="byline"></p><div class="transcript"></div></body></html>');
      popup.document.querySelector('.kicker')!.textContent = templateLabel;
      popup.document.querySelector('h1')!.textContent = documentTitle;
      popup.document.querySelector('.subtitle')!.textContent = templateSubtitle;
      popup.document.querySelector('.byline')!.textContent = attribution;
      popup.document.querySelector('.transcript')!.textContent = timestamped;
      popup.document.close(); popup.focus(); popup.print();
      return;
    }
    const extensions: Record<string, { ext: string; mime: string; text: string }> = {
      txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', text: transcriptDocument },
      md: { ext: 'md', mime: 'text/markdown;charset=utf-8', text: '# ' + documentTitle + '\n\n' + (templateSubtitle ? '**' + templateSubtitle + '**\n\n' : '') + '*' + attribution + '*\n\n' + timestamped },
      html: { ext: 'html', mime: 'text/html;charset=utf-8', text: '<!doctype html><meta charset="utf-8"><title>' + documentTitle.replace(/[&<>"]/g, '') + '</title><main style="max-width:760px;margin:40px auto;padding:0 20px;font:16px/1.75 system-ui;color:#172033"><p style="font-size:10px;letter-spacing:2px;color:#167d91;font-weight:bold">' + templateLabel + '</p><h1>' + documentTitle.replace(/[&<>"]/g, '') + '</h1><p style="color:#475569">' + templateSubtitle + '</p><p style="color:#64748b;font-size:13px">' + attribution + '</p><hr><pre style="white-space:pre-wrap;font:inherit">' + timestamped.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char)) + '</pre></main>' },
      rtf: { ext: 'rtf', mime: 'application/rtf', text: '{\\rtf1\\ansi\\b ' + templateLabel + '\\par\\par ' + documentTitle.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}') + (templateSubtitle ? '\\par ' + templateSubtitle : '') + '\\par\\i ' + attribution + '\\i0\\par\\par ' + timestamped.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, '\\par ') + '}' },
      srt: { ext: 'srt', mime: 'application/x-subrip;charset=utf-8', text: timestampsCoverTranscript ? createTimedSubtitles(timedSegments!, 'srt') : createEstimatedSubtitles(text, 'srt') },
      vtt: { ext: 'vtt', mime: 'text/vtt;charset=utf-8', text: timestampsCoverTranscript ? createTimedSubtitles(timedSegments!, 'vtt') : createEstimatedSubtitles(text, 'vtt') },
    };
    const selected = extensions[exportType] ?? extensions.txt;
    await downloadFile(fileBase + '.' + selected.ext, selected.text, selected.mime);
    if (exportType === 'srt' || exportType === 'vtt') setStatus(timestampsCoverTranscript ? 'Exported speech-aligned subtitle timing from the transcription engine.' : 'The timing data did not cover all transcript text; exported estimated timings so no words are omitted.');
    else if (includeTimestamps && timedSegments?.length && !timestampsCoverTranscript) setStatus('Exported the complete transcript without timestamps because the timing data did not cover all edited text.');
    else if (includeTimestamps && timestampsCoverTranscript) setStatus('Exported the complete transcript with timestamps.');
    setError('');
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus('Copied to clipboard.'); }
    catch { setError('Copy is unavailable in this browser. Select the text and copy it manually.'); }
  }



  function sendVoiceChatMessage() {
    const message = voiceChatInput.trim();
    if (!message) return;
    const mention = message.match(/@([^\\s]+)/)?.[1]?.replace(/[.,!?;:]+$/, '');
    const allTranscripts = [...library, ...files.filter(item => item.transcript.trim()).map(item => ({id:item.id,name:item.file.name,transcript:item.transcript,updatedAt:Date.now()}))];
    const found = mention ? allTranscripts.find(item => item.name.toLowerCase().includes(mention.toLowerCase()) || safeFileBaseName(item.name, '').toLowerCase().includes(mention.toLowerCase())) : undefined;
    if (found) {
      setStudioText(found.transcript);
      setVoiceFilename(safeFileBaseName(found.name, 'aurora-voice'));
      setVoiceChatMessages(items => [...items,{id:crypto.randomUUID(),role:'user',text:message},{id:crypto.randomUUID(),role:'assistant',text:'Loaded @'+found.name+' into your voice script. You can generate it now.'}]);
    } else {
      setStudioText(message.replace(/@[^\\s]+/g, '').trim() || message);
      setVoiceChatMessages(items => [...items,{id:crypto.randomUUID(),role:'user',text:message},{id:crypto.randomUUID(),role:'assistant',text:'Your message is now the voice script. Choose your voice settings and generate the audio below.'}]);
    }
    setVoiceChatInput('');
    setVoiceMentionOpen(false);
  }

  function startVoiceDictation() {
    const w = window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) { setError('Voice input is not supported here. You can still type or attach an audio recording.'); return; }
    const recognition = new Recognition();
    recognition.lang = 'en-NG';
    recognition.onresult = (event: any) => {
      const spoken = event.results?.[0]?.[0]?.transcript || '';
      if (spoken) setVoiceChatInput(value => value ? value + ' ' + spoken : spoken);
    };
    recognition.onerror = () => setError('Could not capture voice input. Please try again.');
    recognition.start();
  }

  async function generateVoice() {
    if (!studioText.trim()) { setError('Add a script or choose a saved transcript first.'); return; }
    if (voiceAudioUrl) URL.revokeObjectURL(voiceAudioUrl);
    setVoiceAudioUrl(''); setVoiceBusy(true); setError(''); setStatus('Preparing your voice…');
    try {
      const chunks = splitLongText(studioText, 3500);
      const audioParts: Blob[] = [];
      for (let index = 0; index < chunks.length; index++) {
        setStatus(chunks.length > 1 ? 'Creating audio section ' + (index + 1) + ' of ' + chunks.length + '…' : 'Creating your audio…');
        const { response } = await requestFeature('/api/tts', {
          text: chunks[index], voice: voiceName,
          style: voiceStyle + '. Accent / pronunciation preference: ' + voiceAccent + '. Emphasis: ' + voiceEmphasis + '. Pauses: ' + voicePauses,
          emotion: voiceEmotion, rate: voiceRate, pitch: voicePitch, language: voiceLanguage,
        }, true);
        const audioPart = await response.blob();
        if (!audioPart.size) throw new Error('No audio was returned.');
        audioParts.push(audioPart);
      }
      const finalAudio = combineMp3Chunks(audioParts);
      setVoiceAudioUrl(URL.createObjectURL(finalAudio));
      setStatus('Your voice audio is ready. Preview it or download the MP3.');
    } catch (reason) {
      setError(reason instanceof Error ? 'Voice generation failed: ' + reason.message : 'Voice generation failed. Check your connection and provider settings.');
      setStatus('');
    } finally { setVoiceBusy(false); }
  }

  async function searchSubtitles() {
    if (subtitleQuery.trim().length < 2) { setError('Enter a film or episode title first.'); return; }
    setSubtitleBusy(true); setSubtitleStatus('Searching for matching subtitles…'); setSubtitleResults([]); setError('');
    try {
      const { data } = await requestFeature('/api/subtitles', { query: subtitleQuery.trim(), languages: subtitleLanguage, type: subtitleType });
      setSubtitleResults(Array.isArray(data?.results) ? data.results : []);
      setSubtitleStatus(data?.results?.length ? 'Choose a matching subtitle release below.' : 'No matching subtitles were found. Try another title or language.');
    } catch (reason) { setSubtitleStatus(reason instanceof Error ? 'Subtitle search failed: ' + reason.message : 'Subtitle search is unavailable right now. Please try again later.'); }
    finally { setSubtitleBusy(false); }
  }

  async function downloadSubtitle(fileId: number, translate = false, releaseName = 'subtitle') {
    setSubtitleBusy(true); setError(''); setSubtitleStatus(translate ? 'Downloading and translating subtitle…' : 'Downloading subtitle…');
    try {
      const { response } = await requestFeature('/api/subtitles-download', { fileId }, true);
      const original = await response.text();
      let output = original;
      if (translate) {
        const parts = splitSubtitleDocument(original, 18000);
        const translated: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          setSubtitleStatus('Translating subtitle section ' + (i + 1) + ' of ' + parts.length + '…');
          const { data } = await requestFeature('/api/translate', { text: parts[i], targetLanguage: subtitleTranslateLanguage, sourceLanguage: subtitleLanguage });
          translated.push(data?.text || '');
        }
        output = translated.join('\n\n');
      }
      const vtt = /^WEBVTT/m.test(output) || /\.vtt$/i.test(releaseName);
      const safeName = releaseName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').slice(0, 70) || 'subtitle';
      const exportText = vtt ? subtitleToVtt(output) : output.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim() + '\n';
      setSubtitleText(exportText); setSubtitleFilename(safeName);
      await downloadFile(safeName + (translate ? '-' + subtitleTranslateLanguage.toLowerCase().replace(/\s+/g, '-') : '') + (vtt ? '.vtt' : '.srt'), exportText, vtt ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8');
      setSubtitleStatus(translate ? 'Translated subtitle exported. Review the timing and wording before use.' : 'Subtitle downloaded.');
    } catch (reason) { setSubtitleStatus(reason instanceof Error ? 'Subtitle download failed: ' + reason.message : 'This subtitle could not be downloaded or translated. Please try another release.'); }
    finally { setSubtitleBusy(false); }
  }

  async function createSubtitlesFromTranscript(format: 'srt' | 'vtt') {
    if (!active?.transcript.trim()) { setSubtitleStatus('Choose a recording with a transcript first.'); return; }
    const segments = active.timedSegments || [];
    const segmentText = segments.map(segment => segment.text).join(' ');
    const hasFullTiming = Boolean(segments.length) && normalizeTranscriptForCompare(segmentText) === normalizeTranscriptForCompare(active.transcript);
    const output = format === 'srt'
      ? hasFullTiming ? createTimedSubtitles(segments, 'srt') : createEstimatedSubtitles(active.transcript, 'srt')
      : hasFullTiming ? createTimedSubtitles(segments, 'vtt') : createEstimatedSubtitles(active.transcript, 'vtt');
    const name = safeFileBaseName(active.file.name.replace(/\.[^.]+$/, ''), 'aurora-subtitles');
    setSubtitleText(output); setSubtitleFilename(name);
    await downloadFile(name + '.' + format, output, format === 'srt' ? 'application/x-subrip;charset=utf-8' : 'text/vtt;charset=utf-8');
    setSubtitleStatus(hasFullTiming ? 'Your speech-aligned subtitles are ready.' : 'Your subtitles are ready with estimated timing. Review them before use.');
  }

  function updateTimedSegment(index: number, value: string) {
    if (!active) return;
    const segments = [...(active.timedSegments || [])];
    const previousText = segments[index]?.text;
    if (previousText === undefined) return;
    segments[index] = { ...segments[index], text: value };
    const completeTimedText = segments.map(segment => segment.text).join(' ');
    const previousTimedText = [...segments.slice(0, index), { ...segments[index], text: previousText }, ...segments.slice(index + 1)].map(segment => segment.text).join(' ');
    const timingCoversTranscript = normalizeTranscriptForCompare(previousTimedText) === normalizeTranscriptForCompare(active.transcript);
    let transcript = active.transcript;
    if (timingCoversTranscript) {
      transcript = completeTimedText;
    } else if (previousText && active.transcript.includes(previousText)) {
      // Preserve any words that have no timing metadata by replacing only the edited segment.
      transcript = active.transcript.replace(previousText, value);
    } else {
      setStatus('Segment timing was updated, but the full transcript was preserved because this segment could not be matched safely.');
    }
    setFiles(current => current.map(item => item.id === active.id ? { ...item, timedSegments: segments, transcript } : item));
  }

  const filteredLibrary = library.filter(item => (item.name + ' ' + item.transcript).toLowerCase().includes(search.toLowerCase()));

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setPage('home')} type="button" aria-label="AURORA VoiceText home">
          <span className="brand-mark"><AudioLines size={24} /></span>
          <span><strong>AURORA <i>VoiceText</i></strong><small>VOICE NOTES, MADE READABLE</small></span>
        </button>
        <span className="local-badge"><span /> VOICE TO TEXT</span>
      </header>

      <nav className="main-nav" aria-label="Main navigation">
        {([['home','Home',Sparkles],['transcribe','Transcribe',WandSparkles],['preview','AI Preview',AudioWaveform],['library','Library',BookOpen],['studio','Voice Workspace',Mic2],['subtitles','Subtitle Finder',Languages]] as const).map(([key,label,Icon]) =>
          <button key={key} type="button" className={page === key ? 'nav-link active' : 'nav-link'} onClick={() => { if (key === 'preview' && active) setPreviewInput(current => current || '@' + active.file.name + ' '); setPage(key); setError(''); }}><Icon size={16}/><span>{label}</span></button>
        )}
      </nav>

      {page === 'home' && <section className="welcome">
        <div className="eyebrow"><Sparkles size={14}/> YOUR PERSONAL VOICE NOTE WORKSPACE</div>
        <h1>Turn voice notes<br/><span>into clear text.</span></h1>
        <p>Transcribe recordings, tidy up the words, save useful notes and export them when you need them.</p>
        <div className="quick-stats"><div><strong>{files.length}</strong><span>In this session</span></div><div><strong>{library.length}</strong><span>Saved notes</span></div><div><strong>₦0</strong><span>To get started</span></div></div>
        <div className="home-actions">
          <button className="primary" onClick={() => { setPage('transcribe'); inputRef.current?.click(); }} type="button"><Upload size={17}/> Choose voice notes</button>
          <button className="secondary" onClick={() => setPage('library')} type="button"><BookOpen size={17}/> Open my library</button>
        </div>
        <div className="info-strip"><ShieldCheck size={18}/><div><strong>Private by default</strong><p>Choose automatic, online or offline transcription. Your original recording stays unchanged.</p></div></div>
        <div className="feature-grid">
          <button onClick={() => setPage('transcribe')} type="button"><FileAudio/><strong>Transcribe</strong><span>Import, listen and correct audio text.</span></button>
          <button onClick={() => setPage('library')} type="button"><BookOpen/><strong>Library</strong><span>Keep transcripts in this browser.</span></button>
          <button onClick={() => setPage('studio')} type="button"><Volume2/><strong>Voice Studio</strong><span>Generate and download AI voiceovers with adjustable delivery.</span></button>
        </div>
      </section>}

      {page === 'transcribe' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">WORKSPACE</div><h1>Transcribe audio</h1><p>Choose a recording, listen, transcribe, then edit the result.</p></div>
        <div className="transcribe-layout">
          <section className="card">
            <div className="card-title"><div><small>STEP 01</small><h2>Your recordings</h2></div><span className="count">{files.length}</span></div>
            <button className="upload-box" type="button" onClick={() => void pickNativeAudioFiles()}><span className="upload-symbol"><Upload/></span><strong>Choose audio files</strong><span>Browse your phone storage</span><small>OPUS · OGG · MP3 · M4A · WAV · AAC</small></button>
            <input ref={inputRef} className="hidden-input" type="file" accept="audio/*,.opus,.ogg,.mp3,.m4a,.wav,.aac,.amr,.3gp,.webm" multiple onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}/>
             <input ref={videoInputRef} className="hidden-input" type="file" accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v" multiple onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}/>
             <button className="text-button" type="button" onClick={() => videoInputRef.current?.click()}><Plus size={16}/> Import video</button>
            <div className="recording-list">{files.map(item => <div key={item.id} className={active?.id === item.id ? 'recording-row selected' : 'recording-row'}><button className="recording-select" onClick={() => {setActiveId(item.id);setError('');}} type="button"><FileAudio size={18}/><span><strong>{item.file.name}</strong><small>{Math.max(1, Math.round((item.nativeSize ?? item.file.size) / 1024))} KB{item.nativeDurationMs ? ' · ' + Math.floor(item.nativeDurationMs / 60000) + ':' + String(Math.floor((item.nativeDurationMs % 60000) / 1000)).padStart(2, '0') : ''}{item.nativeAudioInfo?.sampleRate ? ' · ' + Math.round(item.nativeAudioInfo.sampleRate / 1000) + ' kHz' : ''} · {item.transcript ? 'Transcript ready' : 'Not transcribed yet'}</small></span></button><button className="icon-button" aria-label={'Remove '+item.file.name} onClick={() => removeFile(item.id)} type="button"><X size={16}/></button></div>)}</div>
            {files.length > 0 && <button className="text-button" type="button" onClick={() => void pickNativeAudioFiles()}><Plus size={16}/> Add more audio</button>}

          </section>
          <section className="card">
            <div className="card-title"><div><small>STEP 02</small><h2>Transcript editor</h2></div><span className="language-tag">AUTO LANGUAGE</span></div>
            {active ? <>
              <div className="active-file"><FileAudio size={16}/><span>{active.file.name}</span></div>
{isVideoMediaFile(active.file) ? <video ref={videoRef} className="audio-player" controls playsInline preload="metadata" src={active.url} onTimeUpdate={event => setAudioPlayhead(event.currentTarget.currentTime)}/> :               <audio ref={audioRef} className="audio-player" controls preload="metadata" src={active.url} onTimeUpdate={event => setAudioPlayhead(event.currentTarget.currentTime)}/>}

              <div className="mode-switch" role="group" aria-label="Transcription mode">
                <button className={mode === 'auto' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('auto'); setError(''); }}><Sparkles size={17}/><strong>Auto</strong><small>Recommended</small></button>
                <button className={mode === 'offline' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('offline'); setError(''); }}><ShieldCheck size={17}/><strong>Offline</strong><small>Keep audio on this device</small></button>
                <button className={mode === 'online' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('online'); setError(''); }}><span>☁️</span><strong>Online</strong><small>Use online processing</small></button>
              </div>
              <div className="engine-setup-actions"><button className="secondary full-button" type="button" disabled={busy || offlinePrepBusy} onClick={prepareOfflineEngine}>{offlinePrepBusy ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>} {offlinePrepBusy ? 'Setting up…' : 'Prepare for offline use'}</button></div>
              <p className="helper-text">First-time setup needs internet. Tap once to download and install the speech model and offline audio tools; after setup succeeds, Offline mode can transcribe without data. Keep at least 200 MB free.</p>
              {offlinePrepStatus && <div className="status-message" role="status">{offlinePrepStatus}</div>}

              <div className="studio-actions"><button className="primary full-button" disabled={busy} onClick={transcribe} type="button">{busy ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>} {busy ? 'Working…' : mode === 'auto' ? 'Transcribe automatically' : mode === 'online' ? 'Transcribe online' : 'Transcribe offline'}</button>{busy && <button className="secondary" type="button" onClick={() => transcriptionAbortRef.current?.abort()}>Cancel safely</button>}</div>
              {status && <div className="status-message" role="status">{status}</div>}
              {checkingSavedCheckpoint && <div className="status-message" role="status">Checking this recording for saved transcription progress…</div>}
              {savedCheckpoint && !busy && <div className="status-message" role="status"><strong>Saved progress found:</strong> {savedCheckpoint.completed} of {savedCheckpoint.total} sections completed ({savedCheckpoint.mode} mode). Tap Transcribe to continue from the next unfinished section.</div>}
              {progress.total > 0 && <div className="progress-wrap" aria-label={'Transcription progress: ' + progress.completed + ' of ' + progress.total + ' sections'}><div className="progress-meta"><span>Section progress</span><strong>{Math.round((progress.completed / progress.total) * 100)}%</strong></div><div className="progress-track"><span style={{ width: (progress.completed / progress.total) * 100 + '%' }} /></div><small>{progress.completed} of {progress.total} sections completed · completed sections are saved on this device; reselect the same recording to resume</small></div>}
              <label className="field-label" htmlFor="transcript">Original transcript <small>{active.detectedLanguage ? 'Detected: ' + active.detectedLanguage : 'Language detection: automatic'}</small></label>
              <textarea id="transcript" className="transcript-input" value={active.transcript} onChange={event => updateTranscript(event.target.value)} placeholder="Speech will appear here in its original language. Review names and wording, then edit anything AURORA missed."/>
              
              <div className="editor-tools"><span>{active.transcript.trim() ? active.transcript.trim().split(/\s+/).length : 0} words</span><button className="secondary small-button" type="button" onClick={saveToLibrary}><Save size={15}/> Save to library</button></div>
              <div className="summary-box"><div className="summary-head"><Sparkles size={16}/><strong>Quick key points</strong><button type="button" className="text-button" onClick={() => setSummary(makeSummary(active.transcript))}>Create summary</button></div><p>{summary || 'Create a short extractive summary from the current transcript. Review it before sharing.'}</p></div>
              <section className="export-panel"><div className="export-panel-heading"><div><small>YOUR DOCUMENT</small><strong>Choose an export style</strong></div><FileDown size={20}/></div>
                <label className="field-label" htmlFor="export-filename">Document name<input id="export-filename" value={exportFilename || (active.file.name.replace(/\.[^.]+$/, '') || 'transcript')} onChange={event => setExportFilename(event.target.value)} placeholder="Enter document name"/></label>
                <div className="export-row">
                  <label className="field-label" htmlFor="export-template">Template<AppSelect ariaLabel="Export template" value={exportTemplate} onChange={setExportTemplate} options={[{value:'standard',label:'Professional transcript'},{value:'meeting',label:'Meeting notes'},{value:'study',label:'Study notes'}]}/></label>
                  <label className="field-label" htmlFor="export-type">File format<AppSelect ariaLabel="Export file format" value={exportType} onChange={setExportType} options={[{group:'Documents',value:'docx',label:'Word document (.docx)'},{group:'Documents',value:'pdf',label:'PDF document (.pdf)'},{group:'Documents',value:'rtf',label:'Rich text (.rtf)'},{group:'Documents',value:'html',label:'Web document (.html)'},{group:'Documents',value:'md',label:'Markdown (.md)'},{group:'Documents',value:'txt',label:'Plain text (.txt)'},{group:'Subtitles',value:'srt',label:'SubRip subtitles (.srt)'},{group:'Subtitles',value:'vtt',label:'Web subtitles (.vtt)'}]}/></label>
                </div>
                <label className="export-option"><input type="checkbox" checked={includeTimestamps} onChange={event=>setIncludeTimestamps(event.target.checked)}/> Include timestamps when available</label>
                <div className="export-actions"><button className="primary" type="button" onClick={() => exportTranscript(active.transcript, active.file.name.replace(/\.[^.]+$/, '') || 'transcript', active.timedSegments)}><Download size={16}/> Export {exportType.toUpperCase()}</button><button className="secondary" type="button" onClick={() => copyText(active.transcript)}><Copy size={16}/> Copy text</button></div>
              </section>
            </> : <div className="empty-state"><FileAudio size={30}/><strong>No recording selected</strong><span>Choose an audio file to begin, or paste text in a saved library item.</span></div>}
          </section>
        </div>
      </section>}

      {page === 'library' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">YOUR NOTES</div><h1>Transcript library</h1><p>Saved text stays in this browser on this device. Audio files themselves are not stored here.</p></div>
        <div className="library-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search saved transcripts"/></label><span className="count">{filteredLibrary.length} saved</span></div>
        {filteredLibrary.length ? <div className="library-grid">{filteredLibrary.map(item => <article className="library-card" key={item.id}><div className="library-card-head"><span className="library-icon"><FileText size={18}/></span><button className="icon-button" aria-label="Delete saved transcript" onClick={() => setLibrary(current => current.filter(entry => entry.id !== item.id))} type="button"><Trash2 size={16}/></button></div><h3>{item.name}</h3><small>Saved {new Date(item.updatedAt).toLocaleDateString()}</small><p>{item.transcript.slice(0, 240)}{item.transcript.length > 240 ? '…' : ''}</p><div className="library-actions"><button className="secondary small-button" onClick={() => {setStudioText(item.transcript);setPage('studio');}} type="button"><Volume2 size={15}/> Read aloud</button><button className="secondary small-button" onClick={() => exportTranscript(item.transcript, item.name.replace(/\.[^.]+$/, '') || 'transcript')} type="button"><Download size={15}/> Export</button><button className="text-button" onClick={() => copyText(item.transcript)} type="button"><Copy size={15}/> Copy</button></div></article>)}</div> : <div className="empty-state library-empty"><BookOpen size={32}/><strong>Your library is empty</strong><span>Transcribe or paste a voice note, then tap Save to library.</span><button className="primary" onClick={() => setPage('transcribe')} type="button">Go to transcribe</button></div>}
      </section>}

      {page === 'preview' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">AI PREVIEW</div><h1>Work with your transcript.</h1><p>Ask for a translation, a cleaner draft, or a quick summary.</p></div>
        {active ? <section className="card preview-chat-card">
          <div className="preview-context"><span className="context-dot"/><span>@{active.file.name}</span><button type="button" onClick={()=>setPage('transcribe')}>Change transcript</button></div>
          <div className="preview-chat-feed" aria-live="polite">
            {!previewMessages.length && <div className="chat-welcome"><Sparkles size={22}/><strong>What would you like to do with this transcript?</strong><p>Try “Translate this transcript to Yoruba”, “Polish the wording”, or “Summarize the main points”.</p></div>}
            {previewMessages.map(message=><article key={message.id} className={'chat-message '+message.role}><span>{message.role === 'user' ? 'You' : 'AURORA'}</span><p>{message.text}</p></article>)}
            {previewBusy && <div className="chat-typing"><LoaderCircle className="spin" size={15}/> Working on your transcript…</div>}
          </div>
          <form className="preview-composer" onSubmit={event=>{event.preventDefault();void sendPreviewMessage();}}>
            <textarea value={previewInput} onChange={event=>setPreviewInput(event.target.value)} placeholder={'@' + active.file.name + ' — tell AURORA what to do…'} rows={3} aria-label="Ask AURORA about this transcript"/>
            <div><small>Transcript attached</small><button className="primary" type="submit" disabled={previewBusy || !previewInput.trim()}><Sparkles size={16}/> Send</button></div>
          </form>
          {active.translatedTranscript && <section className="chat-result"><div className="card-title"><div><small>TRANSLATION</small><h2>{transcriptTargetLanguage}</h2></div><button className="secondary small-button" type="button" onClick={()=>copyText(active.translatedTranscript || '')}><Copy size={14}/> Copy</button></div><textarea className="transcript-input" value={active.translatedTranscript} readOnly aria-label="Translated transcript"/></section>}
          <div className="studio-actions"><button className="secondary" type="button" onClick={()=>{setPreviewMessages([]);setPreviewInput('@'+active.file.name+' ');}}><Plus size={15}/> New chat</button><button className="secondary" type="button" onClick={saveToLibrary}><Save size={15}/> Save transcript</button><button className="secondary" type="button" onClick={()=>exportTranscript(active.transcript,active.file.name.replace(/\.[^.]+$/,'')||'transcript',active.timedSegments)}><Download size={15}/> Export</button></div>
          <details className="preview-edit-details"><summary>Edit transcript and timestamps</summary>
{isVideoMediaFile(active.file) ? <video ref={videoRef} className="audio-player" controls playsInline preload="metadata" src={active.url} onTimeUpdate={event=>setAudioPlayhead(event.currentTarget.currentTime)}/> :             <audio ref={audioRef} className="audio-player" controls preload="metadata" src={active.url} onTimeUpdate={event=>setAudioPlayhead(event.currentTarget.currentTime)}/>}
            {active.timedSegments?.length ? <div className="preview-timeline">{active.timedSegments.map((segment,index)=><div className="preview-segment" key={index}><button type="button" className={audioPlayhead>=segment.start&&audioPlayhead<segment.end?'timestamp-chip active':'timestamp-chip'} onClick={()=>{const media=videoRef.current||audioRef.current;if(media){media.currentTime=segment.start;void media.play();}}}>{Math.floor(segment.start/60).toString().padStart(2,'0')}:{Math.floor(segment.start%60).toString().padStart(2,'0')}</button><textarea value={(segment.speaker?segment.speaker+': ':'')+segment.text} rows={2} onChange={event=>updateTimedSegment(index,event.target.value.replace(/^[^:]{1,30}:\s*/,''))} aria-label={'Edit transcript segment '+(index+1)}/></div>)}</div> : <textarea className="transcript-input" value={active.transcript} onChange={event=>updateTranscript(event.target.value)} aria-label="Edit transcript"/>}
          </details>
        </section> : <div className="empty-state"><AudioWaveform/><strong>Select a transcript first</strong><span>Choose or transcribe an audio file to start a chat.</span><button className="primary" onClick={()=>setPage('transcribe')} type="button">Open Transcribe</button></div>}
      </section>}

      {page === 'studio' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">VOICE WORKSPACE</div><h1>Shape audio and give words a voice.</h1><p>Generate voiceovers, preview recordings, trim clips and export finished audio—all in one workspace.</p></div>
        <section className="card studio-card">
          <div className="studio-icon"><Volume2 size={23}/></div>
          <label className="field-label" htmlFor="voice-filename">Audio file name<input id="voice-filename" value={voiceFilename} onChange={event=>setVoiceFilename(event.target.value)} placeholder="Enter audio filename"/></label>
          <div className="studio-source-actions">
            {active?.transcript.trim() && <button className="secondary small-button" type="button" onClick={()=>setStudioText(active.transcript)}><FileText size={15}/> Use current transcript</button>}
            {library.length>0 && <label className="field-label">Saved transcript<AppSelect ariaLabel="Saved transcript" value="" onChange={value=>{const item=library.find(entry=>entry.id===value);if(item)setStudioText(item.transcript);}} options={[{value:'',label:'Choose from library…'},...library.map(item=>({value:item.id,label:item.name}))]}/></label>}
          </div>
          <div className="voice-chat-shell">
            <div className="voice-chat-heading"><div><strong><Sparkles size={16}/> AURORA Voice Chat</strong><span>Type, speak, attach audio, or find an old transcript with @</span></div></div>
            <div className="voice-chat-thread" aria-live="polite">
              {voiceChatMessages.length===0 && <div className="voice-chat-welcome"><Sparkles size={20}/><strong>What should I turn into a voice?</strong><span>Send a message or type @ to search your saved transcripts.</span></div>}
              {voiceChatMessages.map(message=><div key={message.id} className={'voice-chat-message '+message.role}><span>{message.role==='user'?'YOU':'AURORA'}</span><p>{message.text}</p></div>)}
            </div>
            <div className="voice-chat-composer">
              {voiceMentionOpen && <div className="voice-mention-menu"><strong>Matching saved transcripts</strong>{[...library,...files.filter(item=>item.transcript.trim()).map(item=>({id:item.id,name:item.file.name,transcript:item.transcript,updatedAt:Date.now()}))].filter((item,index,all)=>all.findIndex(other=>other.id===item.id)===index).filter(item=>item.name.toLowerCase().includes(voiceMentionQuery.toLowerCase())).slice(0,8).map(item=><button key={item.id} type="button" onClick={()=>{setStudioText(item.transcript);setVoiceFilename(safeFileBaseName(item.name,'aurora-voice'));setVoiceChatMessages(items=>[...items,{id:crypto.randomUUID(),role:'assistant',text:'Loaded @'+item.name+' into your voice script.'}]);setVoiceChatInput('');setVoiceMentionOpen(false);}}><FileText size={15}/><span>@{item.name}<small>{item.transcript.slice(0,80)}</small></span></button>)}{library.length===0&&!files.some(item=>item.transcript.trim())&&<small>No saved transcripts yet. Save a transcript to find it here.</small>}</div>}
              <textarea className="voice-chat-input" aria-label="Message AURORA" value={voiceChatInput} onChange={event=>{setVoiceChatInput(event.target.value);const match=event.target.value.match(/@([^\\s]*)$/);setVoiceMentionOpen(Boolean(match));setVoiceMentionQuery(match?.[1]||'');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendVoiceChatMessage();}}} placeholder="Message AURORA… use @ to find a transcript"/>
              <div className="voice-chat-actions"><button className="secondary small-button" type="button" onClick={startVoiceDictation}><Mic2 size={15}/> Speak</button><button className="secondary small-button" type="button" onClick={()=>voiceAttachmentRef.current?.click()}><Upload size={15}/> Attach audio/video</button><button className="primary small-button" type="button" disabled={!voiceChatInput.trim()} onClick={sendVoiceChatMessage}>Send <AudioLines size={15}/></button></div>
              <input ref={voiceAttachmentRef} className="hidden-input" type="file" accept="audio/*,video/*,.opus,.ogg,.mp3,.m4a,.wav,.aac,.amr,.3gp,.webm,.mp4,.mov,.mkv" multiple onChange={event=>{const chosen=Array.from(event.currentTarget.files||[]);const audio=chosen.filter(file=>file.type.startsWith('audio/')||/\\.(opus|ogg|mp3|m4a|wav|aac|amr|3gp|webm)$/i.test(file.name));const video=chosen.filter(file=>file.type.startsWith('video/')||/\\.(mp4|mov|mkv)$/i.test(file.name));if(audio.length)addFiles(audio);if(video.length)setError('Your video is ready for automatic audio-track transcription.');setVoiceChatMessages(items=>[...items,...chosen.map(file=>({id:crypto.randomUUID(),role:'user' as const,text:'Attached '+file.name}))]);event.currentTarget.value='';}}/>
            </div>
          </div>
          <label className="field-label" htmlFor="studio-text">Voice script preview</label>
          <textarea id="studio-text" className="transcript-input studio-input" value={studioText} onChange={event => setStudioText(event.target.value)} placeholder="The selected transcript or your chat message will appear here…"/>
          <div className="studio-grid studio-primary-options">
            <label className="field-label">Voice<AppSelect ariaLabel="Voice" value={voiceName} onChange={setVoiceName} options={[{value:'nova',label:'Nova · bright'},{value:'shimmer',label:'Shimmer · clear'},{value:'coral',label:'Coral · warm'},{value:'sage',label:'Sage · measured'},{value:'onyx',label:'Onyx · deep'},{value:'echo',label:'Echo · clear'},{value:'ash',label:'Ash · conversational'},{value:'fable',label:'Fable · narrator'},{value:'alloy',label:'Alloy · neutral'}]}/></label>
            <label className="field-label">Delivery<AppSelect ariaLabel="Voice delivery" value={voiceStyle} onChange={setVoiceStyle} options={['Natural, conversational delivery','Professional presenter, polished and confident','Storytelling, expressive and vivid','Documentary narrator, steady and authoritative','Energetic, upbeat and engaging','Calm, gentle and reassuring'].map(value=>({value,label:value}))}/></label>
          </div>
          <details className="voice-advanced"><summary>More voice controls</summary>
            <div className="studio-grid">
              <label className="field-label">Emotion<AppSelect ariaLabel="Voice emotion" value={voiceEmotion} onChange={setVoiceEmotion} options={['Warm and friendly','Neutral and informative','Excited and enthusiastic','Serious and thoughtful','Hopeful and inspiring'].map(value=>({value,label:value}))}/></label>
              <label className="field-label">Language<AppSelect ariaLabel="Voice language" value={voiceLanguage} onChange={setVoiceLanguage} options={[{"value":"Auto-detect","label":"Auto-detect"},{"value":"English","label":"English"},{"value":"Arabic","label":"Arabic"},{"value":"Bengali","label":"Bengali"},{"value":"Bulgarian","label":"Bulgarian"},{"value":"Burmese","label":"Burmese"},{"value":"Catalan","label":"Catalan"},{"value":"Chinese","label":"Chinese"},{"value":"Croatian","label":"Croatian"},{"value":"Czech","label":"Czech"},{"value":"Danish","label":"Danish"},{"value":"Dutch","label":"Dutch"},{"value":"Estonian","label":"Estonian"},{"value":"Finnish","label":"Finnish"},{"value":"French","label":"French"},{"value":"German","label":"German"},{"value":"Greek","label":"Greek"},{"value":"Gujarati","label":"Gujarati"},{"value":"Hausa","label":"Hausa"},{"value":"Hebrew","label":"Hebrew"},{"value":"Hindi","label":"Hindi"},{"value":"Hungarian","label":"Hungarian"},{"value":"Icelandic","label":"Icelandic"},{"value":"Indonesian","label":"Indonesian"},{"value":"Irish","label":"Irish"},{"value":"Italian","label":"Italian"},{"value":"Japanese","label":"Japanese"},{"value":"Javanese","label":"Javanese"},{"value":"Kannada","label":"Kannada"},{"value":"Kazakh","label":"Kazakh"},{"value":"Khmer","label":"Khmer"},{"value":"Korean","label":"Korean"},{"value":"Lao","label":"Lao"},{"value":"Latvian","label":"Latvian"},{"value":"Lithuanian","label":"Lithuanian"},{"value":"Macedonian","label":"Macedonian"},{"value":"Malay","label":"Malay"},{"value":"Malayalam","label":"Malayalam"},{"value":"Marathi","label":"Marathi"},{"value":"Mongolian","label":"Mongolian"},{"value":"Nepali","label":"Nepali"},{"value":"Norwegian","label":"Norwegian"},{"value":"Persian","label":"Persian"},{"value":"Polish","label":"Polish"},{"value":"Portuguese","label":"Portuguese"},{"value":"Punjabi","label":"Punjabi"},{"value":"Romanian","label":"Romanian"},{"value":"Russian","label":"Russian"},{"value":"Serbian","label":"Serbian"},{"value":"Slovak","label":"Slovak"},{"value":"Slovenian","label":"Slovenian"},{"value":"Somali","label":"Somali"},{"value":"Spanish","label":"Spanish"},{"value":"Swahili","label":"Swahili"},{"value":"Swedish","label":"Swedish"},{"value":"Tagalog","label":"Tagalog"},{"value":"Tamil","label":"Tamil"},{"value":"Telugu","label":"Telugu"},{"value":"Thai","label":"Thai"},{"value":"Turkish","label":"Turkish"},{"value":"Ukrainian","label":"Ukrainian"},{"value":"Urdu","label":"Urdu"},{"value":"Uzbek","label":"Uzbek"},{"value":"Vietnamese","label":"Vietnamese"},{"value":"Yoruba","label":"Yoruba"},{"value":"Igbo","label":"Igbo"},{"value":"Zulu","label":"Zulu"},{"value":"Amharic","label":"Amharic"},{"value":"Afrikaans","label":"Afrikaans"},{"value":"Xhosa","label":"Xhosa"},{"value":"Kinyarwanda","label":"Kinyarwanda"},{"value":"Pashto","label":"Pashto"},{"value":"Sinhala","label":"Sinhala"},{"value":"Azerbaijani","label":"Azerbaijani"},{"value":"Armenian","label":"Armenian"},{"value":"Georgian","label":"Georgian"},{"value":"Basque","label":"Basque"},{"value":"Galician","label":"Galician"},{"value":"Welsh","label":"Welsh"},{"value":"Albanian","label":"Albanian"},{"value":"Bosnian","label":"Bosnian"},{"value":"Cebuano","label":"Cebuano"},{"value":"Malagasy","label":"Malagasy"},{"value":"Chichewa","label":"Chichewa"},{"value":"Shona","label":"Shona"},{"value":"Sundanese","label":"Sundanese"},{"value":"Kurdish","label":"Kurdish"},{"value":"Scottish Gaelic","label":"Scottish Gaelic"},{"value":"Māori","label":"Māori"},{"value":"Luxembourgish","label":"Luxembourgish"},{"value":"Maltese","label":"Maltese"},{"value":"Yiddish","label":"Yiddish"},{"value":"Faroese","label":"Faroese"},{"value":"Tatar","label":"Tatar"},{"value":"Tajik","label":"Tajik"}]}/></label>
              <label className="field-label">Accent<AppSelect ariaLabel="Voice accent" value={voiceAccent} onChange={setVoiceAccent} options={['International English','British English','American English','Australian English','Indian English','South African English','Irish English','Scottish English','New Zealand English','Canadian English','Singapore English'].map(value=>({value,label:value}))}/></label>
              <label className="field-label">Emphasis<AppSelect ariaLabel="Voice emphasis" value={voiceEmphasis} onChange={setVoiceEmphasis} options={['Natural emphasis','Subtle emphasis','Expressive emphasis','Strong key-word emphasis'].map(value=>({value,label:value}))}/></label>
              <label className="field-label">Pauses<AppSelect ariaLabel="Voice pauses" value={voicePauses} onChange={setVoicePauses} options={['Natural pauses','Short pauses','Long storytelling pauses','Presenter pacing'].map(value=>({value,label:value}))}/></label>
            </div>
            <div className="sliders"><label>Speed <strong>{voiceRate.toFixed(1)}×</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voiceRate} onChange={event=>setVoiceRate(Number(event.target.value))}/></label><label>Pitch preference <strong>{voicePitch.toFixed(1)}</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voicePitch} onChange={event=>setVoicePitch(Number(event.target.value))}/></label></div>
          </details>
          <div className="studio-actions"><button className="primary" type="button" disabled={voiceBusy} onClick={generateVoice}>{voiceBusy?<LoaderCircle className="spin" size={17}/>:<AudioWaveform size={17}/>} {voiceBusy?'Generating AI audio…':'Generate AI voice'}</button><button className="secondary" type="button" onClick={()=>{setStudioText('');if(voiceAudioUrl)URL.revokeObjectURL(voiceAudioUrl);setVoiceAudioUrl('');}}>Clear</button></div>
          {status && <div className="status-message" role="status">{status}</div>}
          {voiceAudioUrl && <div className="generated-audio"><strong>Your generated voice audio</strong><audio controls preload="metadata" src={voiceAudioUrl}/><a className="primary download-link" href={voiceAudioUrl} download={safeFileBaseName(voiceFilename, 'aurora-voice') + '.mp3'}><Download size={16}/> Download MP3 audio</a></div>}
        </section>
        <div className="voice-workspace-grid">
          {!active ? <div className="empty-state"><AudioWaveform/><strong>No recording selected</strong><span>Import an audio file in Transcribe, then return here to edit it.</span><button className="primary" onClick={()=>setPage('transcribe')} type="button">Open Transcribe</button></div> : <section className="card studio-card">
          <div className="card-title"><div><small>SELECTED RECORDING</small><h2>{active.file.name}</h2></div><button className="secondary small-button" type="button" onClick={()=>setPage('transcribe')}>Change file</button></div>
{isVideoMediaFile(active.file) ? <video ref={videoRef} className="audio-player" controls playsInline preload="metadata" src={active.url} onLoadedMetadata={event=>{const duration=event.currentTarget.duration||0;setEditorDuration(duration);setEditorStart(0);setEditorEnd(duration);}} onTimeUpdate={event=>{const current=event.currentTarget.currentTime;setAudioPlayhead(current);if(editorEnd>0&&current>=editorEnd){event.currentTarget.pause();event.currentTarget.currentTime=editorStart;}}}/>
          <div className="studio-grid">
            <label className="field-label">Start time (seconds)<input type="number" min="0" max={editorDuration||undefined} step="0.1" value={editorStart} onChange={event=>setEditorStart(Math.max(0,Math.min(Number(event.target.value)||0,editorDuration||Number.MAX_SAFE_INTEGER)))}/></label>
            <label className="field-label">End time (seconds)<input type="number" min={editorStart} max={editorDuration||undefined} step="0.1" value={editorEnd} onChange={event=>setEditorEnd(Math.max(editorStart,Math.min(Number(event.target.value)||0,editorDuration||Number.MAX_SAFE_INTEGER)))}/></label>
          </div>
          <div className="info-strip"><AudioWaveform size={18}/><div><strong>Selection length: {Math.max(0,editorEnd-editorStart).toFixed(1)} seconds</strong><p>Full recording: {editorDuration ? Math.floor(editorDuration/60)+':'+String(Math.floor(editorDuration%60)).padStart(2,'0') : 'Loading duration…'} · Playback stops at the selected end point.</p></div></div>
          <div className="studio-actions">
            <button className="secondary" type="button" disabled={!editorDuration} onClick={()=>{if(audioRef.current){audioRef.current.currentTime=editorStart;void audioRef.current.play();}}}>Preview selection</button>
            <button className="secondary" type="button" disabled={!editorDuration} onClick={()=>{setEditorStart(0);setEditorEnd(editorDuration);if(audioRef.current)audioRef.current.currentTime=0;}}>Reset selection</button>
            <button className="primary" type="button" disabled={editorBusy||!editorDuration||editorEnd<=editorStart} onClick={async()=>{setEditorBusy(true);setError('');try{let wavBase64:string;if(active.nativePath){const result=await nativeAudioFiles.decodeSegment({path:active.nativePath,startSeconds:editorStart,durationSeconds:editorEnd-editorStart});wavBase64=result.wavBase64;}else{const context=new AudioContext();try{const decoded=await context.decodeAudioData(await active.file.arrayBuffer());const start=Math.floor(editorStart*decoded.sampleRate);const end=Math.min(decoded.length,Math.floor(editorEnd*decoded.sampleRate));if(end<=start)throw new Error('Choose a valid audio range.');const channels=decoded.numberOfChannels;const length=end-start;const buffer=new ArrayBuffer(44+length*channels*2);const view=new DataView(buffer);const write=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};write(0,'RIFF');view.setUint32(4,36+length*channels*2,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,decoded.sampleRate,true);view.setUint32(28,decoded.sampleRate*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,length*channels*2,true);let offset=44;for(let i=0;i<length;i++)for(let channel=0;channel<channels;channel++){const sample=Math.max(-1,Math.min(1,decoded.getChannelData(channel)[start+i]));view.setInt16(offset,sample<0?sample*32768:sample*32767,true);offset+=2;}const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+0x8000,bytes.length)));wavBase64=btoa(binary);}finally{await context.close();}}const binary=atob(wavBase64);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);await downloadFile(safeFileBaseName(active.file.name.replace(/\.[^.]+$/,'')+'-clip','aurora-clip')+'.wav',new Blob([bytes],{type:'audio/wav'}),'audio/wav');setStatus('Trimmed audio clip exported. Your original file was not changed.');}catch(reason){setError(reason instanceof Error?reason.message:'Could not export this audio section.');}finally{setEditorBusy(false);}}}>{editorBusy?<LoaderCircle className="spin" size={16}/>:<Download size={16}/>} {editorBusy?'Preparing clip…':'Export selected clip (WAV)'}</button>
          </div>
          <p className="field-hint">For large recordings, export shorter sections to keep memory use manageable on your phone. The exported clip is a new WAV file; the source recording is preserved.</p>
        </section>}
        </div>
      </section>}


      {page === 'subtitles' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">SUBTITLE WORKSPACE</div><h1>Create or find subtitles.</h1><p>Make subtitles from your transcript, or find an existing subtitle file for a film or episode.</p></div>
        <section className="card subtitle-create-card">
          <div className="subtitle-section-heading"><div><small>01 · CREATE</small><h2>Make subtitles from your audio</h2><p>{active?.transcript.trim() ? 'Ready to create subtitles from ' + active.file.name : 'Choose and transcribe an audio file first.'}</p></div><span className="subtitle-step-icon"><AudioWaveform size={20}/></span></div>
          {active?.transcript.trim() ? <div className="subtitle-create-actions"><button className="primary" type="button" onClick={()=>createSubtitlesFromTranscript('srt')}><FileDown size={16}/> Create SRT</button><button className="secondary" type="button" onClick={()=>createSubtitlesFromTranscript('vtt')}><FileDown size={16}/> Create VTT</button><button className="text-button" type="button" onClick={()=>setPage('transcribe')}>Review transcript</button></div> : <button className="primary" type="button" onClick={()=>setPage('transcribe')}>Open Transcribe</button>}
        </section>
        <section className="card subtitle-card">
          <div className="subtitle-section-heading"><div><small>02 · FIND</small><h2>Find an existing subtitle</h2><p>Search by title, content type and language.</p></div><span className="subtitle-step-icon"><Search size={20}/></span></div>
          <label className="field-label" htmlFor="subtitle-query">Film or series title<input id="subtitle-query" value={subtitleQuery} onChange={event=>setSubtitleQuery(event.target.value)} placeholder="e.g. film or episode title"/></label>
          <div className="studio-grid"><label className="field-label">Content type<AppSelect ariaLabel="Subtitle content type" value={subtitleType || 'all'} onChange={value=>setSubtitleType(value === 'all' ? undefined : value as 'movie' | 'episode')} options={[{value:'all',label:'Movies & series'},{value:'movie',label:'Movie'},{value:'episode',label:'TV episode'}]}/></label><label className="field-label">Find subtitles in<AppSelect ariaLabel="Subtitle language" value={subtitleLanguage} onChange={setSubtitleLanguage} options={[{value:'en',label:'English'},{value:'ar',label:'Arabic'},{value:'bn',label:'Bengali'},{value:'bg',label:'Bulgarian'},{value:'my',label:'Burmese'},{value:'ca',label:'Catalan'},{value:'zh',label:'Chinese'},{value:'hr',label:'Croatian'},{value:'cs',label:'Czech'},{value:'da',label:'Danish'},{value:'nl',label:'Dutch'},{value:'et',label:'Estonian'},{value:'fi',label:'Finnish'},{value:'fr',label:'French'},{value:'de',label:'German'},{value:'el',label:'Greek'},{value:'gu',label:'Gujarati'},{value:'ha',label:'Hausa'},{value:'he',label:'Hebrew'},{value:'hi',label:'Hindi'},{value:'hu',label:'Hungarian'},{value:'is',label:'Icelandic'},{value:'id',label:'Indonesian'},{value:'ga',label:'Irish'},{value:'it',label:'Italian'},{value:'ja',label:'Japanese'},{value:'jv',label:'Javanese'},{value:'kn',label:'Kannada'},{value:'kk',label:'Kazakh'},{value:'km',label:'Khmer'},{value:'ko',label:'Korean'},{value:'lo',label:'Lao'},{value:'lv',label:'Latvian'},{value:'lt',label:'Lithuanian'},{value:'mk',label:'Macedonian'},{value:'ms',label:'Malay'},{value:'ml',label:'Malayalam'},{value:'mr',label:'Marathi'},{value:'mn',label:'Mongolian'},{value:'ne',label:'Nepali'},{value:'no',label:'Norwegian'},{value:'fa',label:'Persian'},{value:'pl',label:'Polish'},{value:'pt',label:'Portuguese'},{value:'pa',label:'Punjabi'},{value:'ro',label:'Romanian'},{value:'ru',label:'Russian'},{value:'sr',label:'Serbian'},{value:'sk',label:'Slovak'},{value:'sl',label:'Slovenian'},{value:'so',label:'Somali'},{value:'es',label:'Spanish'},{value:'sw',label:'Swahili'},{value:'sv',label:'Swedish'},{value:'tl',label:'Tagalog'},{value:'ta',label:'Tamil'},{value:'te',label:'Telugu'},{value:'th',label:'Thai'},{value:'tr',label:'Turkish'},{value:'uk',label:'Ukrainian'},{value:'ur',label:'Urdu'},{value:'uz',label:'Uzbek'},{value:'vi',label:'Vietnamese'},{value:'yo',label:'Yoruba'},{value:'ig',label:'Igbo'},{value:'zu',label:'Zulu'},{value:'am',label:'Amharic'},{value:'af',label:'Afrikaans'},{value:'xh',label:'Xhosa'},{value:'rw',label:'Kinyarwanda'},{value:'ps',label:'Pashto'},{value:'si',label:'Sinhala'},{value:'az',label:'Azerbaijani'},{value:'hy',label:'Armenian'},{value:'ka',label:'Georgian'},{value:'eu',label:'Basque'},{value:'gl',label:'Galician'},{value:'cy',label:'Welsh'},{value:'sq',label:'Albanian'},{value:'bs',label:'Bosnian'},{value:'ceb',label:'Cebuano'},{value:'mg',label:'Malagasy'},{value:'ny',label:'Chichewa'},{value:'sn',label:'Shona'},{value:'su',label:'Sundanese'},{value:'ku',label:'Kurdish'},{value:'gd',label:'Scottish Gaelic'},{value:'mi',label:'Māori'},{value:'lb',label:'Luxembourgish'},{value:'mt',label:'Maltese'},{value:'yi',label:'Yiddish'},{value:'fo',label:'Faroese'},{value:'tt',label:'Tatar'},{value:'tg',label:'Tajik'}]}/></label><label className="field-label">Translate downloaded subtitle to<AppSelect ariaLabel="Translate subtitle to" value={subtitleTranslateLanguage} onChange={setSubtitleTranslateLanguage} options={[{value:'English',label:'English'},{value:'Arabic',label:'Arabic'},{value:'Bengali',label:'Bengali'},{value:'Bulgarian',label:'Bulgarian'},{value:'Burmese',label:'Burmese'},{value:'Catalan',label:'Catalan'},{value:'Chinese',label:'Chinese'},{value:'Croatian',label:'Croatian'},{value:'Czech',label:'Czech'},{value:'Danish',label:'Danish'},{value:'Dutch',label:'Dutch'},{value:'Estonian',label:'Estonian'},{value:'Finnish',label:'Finnish'},{value:'French',label:'French'},{value:'German',label:'German'},{value:'Greek',label:'Greek'},{value:'Gujarati',label:'Gujarati'},{value:'Hausa',label:'Hausa'},{value:'Hebrew',label:'Hebrew'},{value:'Hindi',label:'Hindi'},{value:'Hungarian',label:'Hungarian'},{value:'Icelandic',label:'Icelandic'},{value:'Indonesian',label:'Indonesian'},{value:'Irish',label:'Irish'},{value:'Italian',label:'Italian'},{value:'Japanese',label:'Japanese'},{value:'Javanese',label:'Javanese'},{value:'Kannada',label:'Kannada'},{value:'Kazakh',label:'Kazakh'},{value:'Khmer',label:'Khmer'},{value:'Korean',label:'Korean'},{value:'Lao',label:'Lao'},{value:'Latvian',label:'Latvian'},{value:'Lithuanian',label:'Lithuanian'},{value:'Macedonian',label:'Macedonian'},{value:'Malay',label:'Malay'},{value:'Malayalam',label:'Malayalam'},{value:'Marathi',label:'Marathi'},{value:'Mongolian',label:'Mongolian'},{value:'Nepali',label:'Nepali'},{value:'Norwegian',label:'Norwegian'},{value:'Persian',label:'Persian'},{value:'Polish',label:'Polish'},{value:'Portuguese',label:'Portuguese'},{value:'Punjabi',label:'Punjabi'},{value:'Romanian',label:'Romanian'},{value:'Russian',label:'Russian'},{value:'Serbian',label:'Serbian'},{value:'Slovak',label:'Slovak'},{value:'Slovenian',label:'Slovenian'},{value:'Somali',label:'Somali'},{value:'Spanish',label:'Spanish'},{value:'Swahili',label:'Swahili'},{value:'Swedish',label:'Swedish'},{value:'Tagalog',label:'Tagalog'},{value:'Tamil',label:'Tamil'},{value:'Telugu',label:'Telugu'},{value:'Thai',label:'Thai'},{value:'Turkish',label:'Turkish'},{value:'Ukrainian',label:'Ukrainian'},{value:'Urdu',label:'Urdu'},{value:'Uzbek',label:'Uzbek'},{value:'Vietnamese',label:'Vietnamese'},{value:'Yoruba',label:'Yoruba'},{value:'Igbo',label:'Igbo'},{value:'Zulu',label:'Zulu'},{value:'Amharic',label:'Amharic'},{value:'Afrikaans',label:'Afrikaans'},{value:'Xhosa',label:'Xhosa'},{value:'Kinyarwanda',label:'Kinyarwanda'},{value:'Pashto',label:'Pashto'},{value:'Sinhala',label:'Sinhala'},{value:'Azerbaijani',label:'Azerbaijani'},{value:'Armenian',label:'Armenian'},{value:'Georgian',label:'Georgian'},{value:'Basque',label:'Basque'},{value:'Galician',label:'Galician'},{value:'Welsh',label:'Welsh'},{value:'Albanian',label:'Albanian'},{value:'Bosnian',label:'Bosnian'},{value:'Cebuano',label:'Cebuano'},{value:'Malagasy',label:'Malagasy'},{value:'Chichewa',label:'Chichewa'},{value:'Shona',label:'Shona'},{value:'Sundanese',label:'Sundanese'},{value:'Kurdish',label:'Kurdish'},{value:'Scottish Gaelic',label:'Scottish Gaelic'},{value:'Māori',label:'Māori'},{value:'Luxembourgish',label:'Luxembourgish'},{value:'Maltese',label:'Maltese'},{value:'Yiddish',label:'Yiddish'},{value:'Faroese',label:'Faroese'},{value:'Tatar',label:'Tatar'},{value:'Tajik',label:'Tajik'}]}/></label></div>
          <button className="primary full-button" disabled={subtitleBusy} onClick={searchSubtitles} type="button">{subtitleBusy?<LoaderCircle className="spin" size={17}/>:<Search size={17}/>} {subtitleBusy?'Searching…':'Search subtitles'}</button>
          {subtitleStatus && <div className="status-message" role="status">{subtitleStatus}</div>}
          {subtitleResults.length>0 && <div className="subtitle-results">{subtitleResults.map((item,index)=><article className="subtitle-result" key={item.id+'-'+index}><div className="subtitle-result-main"><strong>{item.title} {item.year?'('+item.year+')':''}</strong><p>{item.language.toUpperCase()} · {item.release||item.fileName}{item.season ? ' · S'+String(item.season).padStart(2,'0')+(item.episode ? ' E'+String(item.episode).padStart(2,'0') : '') : ''}</p><small>{item.downloads.toLocaleString()} downloads{item.hearingImpaired ? ' · SDH' : ''}</small></div><div className="subtitle-actions"><button className="secondary small-button" disabled={subtitleBusy||!item.fileId} onClick={()=>downloadSubtitle(item.fileId!,false,item.fileName)} type="button"><Download size={14}/> Download</button><button className="primary small-button" disabled={subtitleBusy||!item.fileId} onClick={()=>downloadSubtitle(item.fileId!,true,item.fileName)} type="button"><Languages size={14}/> Translate</button></div></article>)}</div>}
          {subtitleText && <div className="subtitle-preview"><div className="card-title"><div><small>SUBTITLE PREVIEW</small><h2>{subtitleFilename}</h2></div><span className="count">Editable</span></div><textarea value={subtitleText} onChange={event=>setSubtitleText(event.target.value)} rows={10} aria-label="Edit subtitle text"/><div className="studio-actions"><button className="secondary" onClick={()=>void downloadFile(subtitleFilename+'.srt',subtitleToSrt(subtitleText),'application/x-subrip;charset=utf-8').catch(reason=>setSubtitleStatus(reason instanceof Error ? reason.message : 'Could not export SRT.'))} type="button"><FileDown size={15}/> Export SRT</button><button className="secondary" onClick={()=>void downloadFile(subtitleFilename+'.vtt',subtitleToVtt(subtitleText),'text/vtt;charset=utf-8').catch(reason=>setSubtitleStatus(reason instanceof Error ? reason.message : 'Could not export VTT.'))} type="button"><FileDown size={15}/> Export VTT</button></div></div>}
        </section>
      </section>}

      {page === 'settings' && <section className="page-content"><div className="page-heading"><div className="eyebrow">PREFERENCES</div><h1>Settings & privacy</h1><p>Manage your saved transcripts and exported work.</p></div><section className="card settings-card"><div className="setting-row"><span className="setting-icon"><ShieldCheck/></span><div><strong>Offline use</strong><p>Prepare this device once to make offline transcription available.</p></div></div><div className="setting-row"><span className="setting-icon"><BookOpen/></span><div><strong>Saved transcripts</strong><p>{library.length} transcript(s) saved on this device. Your library stays on this device unless you export a backup.</p></div><button className="secondary small-button" onClick={() => {if (window.confirm('Delete all saved transcripts from this browser?')) setLibrary([]);}} type="button"><Trash2 size={15}/> Clear library</button></div><div className="setting-row"><span className="setting-icon"><Download/></span><div><strong>Back up your library</strong><p>Export a JSON backup or restore one later. Importing merges saved transcripts and keeps existing entries.</p></div><div className="library-actions"><button className="secondary small-button" type="button" onClick={()=>void exportLibraryBackup().catch(reason=>setError(reason instanceof Error?reason.message:'Could not export library backup.'))}><Download size={15}/> Export backup</button><button className="secondary small-button" type="button" onClick={()=>libraryImportRef.current?.click()}><Upload size={15}/> Import backup</button><input ref={libraryImportRef} className="hidden-input" type="file" accept=".json,application/json" onChange={event=>void importLibraryBackup(event.currentTarget.files?.[0])}/></div></div><div className="setting-row"><span className="setting-icon"><Mic2/></span><div><strong>Voice Studio</strong><p>Create a voice version of your text and download the finished audio.</p></div></div><div className="setting-row"><span className="setting-icon"><FileText/></span><div><strong>Export your work</strong><p>Download transcripts and subtitles in the format you need.</p></div></div></section></section>}

      {error && <div className="error-message" role="alert"><span>{error}</span>{page === 'transcribe' && active && transcriptionFailed && <button className="secondary small-button" onClick={transcribe} disabled={busy} type="button"><WandSparkles size={15}/> Retry from saved section</button>}<button onClick={() => { setError(''); if (transcriptionFailed) setTranscriptionFailed(false); }} aria-label="Dismiss error" type="button"><X size={16}/></button></div>}
      <footer className="footer"><span><AudioLines size={15}/> AURORA VoiceText</span><span><ShieldCheck size={14}/> Your voice notes, made readable</span></footer>
    </main>
  );
}

export default App;
