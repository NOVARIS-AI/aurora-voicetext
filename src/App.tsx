import { useEffect, useRef, useState } from 'react';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createEstimatedSubtitles, createTimedSubtitles, mergeTranscriptParts } from './audio-utils';
import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import {
  AudioLines, Upload, FileAudio, X, Copy, Download, Plus, Sparkles,
  ShieldCheck, Clock3, WandSparkles, LoaderCircle, FileText,
  Settings2, Mic2, Volume2, BookOpen, Trash2, Save, Languages, Search, FileDown, AudioWaveform,
} from 'lucide-react';

type Recording = { id: string; name: string; transcript: string; updatedAt: number };
type TimedSegment = { start: number; end: number; text: string; speaker?: string };
type BackgroundTranscriptionBridge = { start: () => Promise<void>; stop: () => Promise<void> };
const backgroundTranscription = registerPlugin<BackgroundTranscriptionBridge>('BackgroundTranscription');
type AudioFile = { id: string; file: File; url: string; transcript: string; translatedTranscript?: string; detectedLanguage?: string; timedSegments?: TimedSegment[] };
type Page = 'home' | 'transcribe' | 'library' | 'preview' | 'studio' | 'subtitles' | 'settings';
type Engine = (audio: Float32Array, options: { sampling_rate: number; chunk_length_s?: number; stride_length_s?: number }) => Promise<{ text?: string }>;
type TranscriptionMode = 'auto' | 'offline' | 'online';
type TranscriptionCheckpoint = { fileId: string; parts: string[]; nextChunk: number; totalChunks: number; segments?: TimedSegment[] };

const STORAGE_KEY = 'aurora-voicetext-library-v2';
const API_BASE_URL = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');
const BACKUP_API_BASE_URL = ((import.meta.env.VITE_BACKUP_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');
const transcriptionApiUrl = `${API_BASE_URL}/api/transcribe`;
const backupTranscriptionApiUrl = BACKUP_API_BASE_URL ? `${BACKUP_API_BASE_URL}/api/transcribe` : '';
let pipelinePromise: Promise<Engine> | null = null;
let voskModelPromise: Promise<any> | null = null;
const VOSK_MODEL_URL = (import.meta.env.VITE_VOSK_MODEL_URL as string | undefined) ||
  'https://fiddle-app.github.io/voice-models/vosk-model-small-en-us-0.15.tar.gz';
const VOSK_MODEL_CACHE_NAME = 'aurora-voicetext-vosk-model-v1';
const VOSK_MODEL_CACHE_KEY = 'https://aurora-voicetext.local/offline-models/vosk-model-small-en-us-0.15.tar.gz';

async function requestFeature(path: string, payload: unknown, binary = false): Promise<{ response: Response; data?: any }> {
  const primary = API_BASE_URL ? API_BASE_URL + path : path;
  const urls = [primary, ...(BACKUP_API_BASE_URL ? [BACKUP_API_BASE_URL + path] : [])];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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

async function mergeMp3ChunksToWav(parts: Blob[]): Promise<Blob> {
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Audio decoding is unavailable on this device.');
  const context: AudioContext = new AudioContextClass();
  try {
    const decoded: AudioBuffer[] = [];
    for (const part of parts) decoded.push(await context.decodeAudioData(await part.arrayBuffer()));
    const sampleRate = Math.max(...decoded.map(item => item.sampleRate));
    const channels = Math.min(2, Math.max(...decoded.map(item => item.numberOfChannels)));
    const totalFrames = decoded.reduce((sum, item) => sum + Math.ceil(item.duration * sampleRate), 0);
    const pcm = Array.from({ length: channels }, () => new Float32Array(totalFrames));
    let offset = 0;
    for (const item of decoded) {
      const frames = Math.ceil(item.duration * sampleRate);
      for (let channel = 0; channel < channels; channel++) {
        const source = item.getChannelData(Math.min(channel, item.numberOfChannels - 1));
        for (let i = 0; i < frames; i++) {
          const sourceIndex = Math.min(source.length - 1, Math.floor(i * item.sampleRate / sampleRate));
          pcm[channel][offset + i] = source[sourceIndex] || 0;
        }
      }
      offset += frames;
    }
    const bytesPerSample = 2, blockAlign = channels * bytesPerSample, dataSize = totalFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize), view = new DataView(buffer);
    const write = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); write(8, 'WAVE'); write(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, dataSize, true);
    let at = 44;
    for (let frame = 0; frame < totalFrames; frame++) for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, pcm[channel][frame]));
      view.setInt16(at, sample < 0 ? sample * 32768 : sample * 32767, true); at += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  } finally { await context.close().catch(() => undefined); }
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
      const request = db.transaction('checkpoints', 'readwrite').objectStore('checkpoints').put({ fileKey, checkpoint, savedAt: Date.now() });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function removeSavedCheckpoint(fileKey: string): Promise<void> {
  const db = await openCheckpointDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction('checkpoints', 'readwrite').objectStore('checkpoints').delete(fileKey);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/**
 * Keep decoder working sets smaller on constrained phones.
 * This reduces per-section memory use; it does not yet make whole-file
 * FFmpeg input loading streaming/disk-backed.
 */
function getAudioSegmentSeconds(): number {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency || 2;
  if (typeof memory === 'number' && memory <= 2) return 45;
  if (typeof memory === 'number' && memory <= 4) return 75;
  if (cores <= 4) return 75;
  return 120;
}

function isUsableCheckpoint(value: unknown, totalChunks: number): value is TranscriptionCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const checkpoint = value as Partial<TranscriptionCheckpoint>;
  return checkpoint.totalChunks === totalChunks &&
    Number.isInteger(checkpoint.nextChunk) &&
    (checkpoint.nextChunk as number) >= 0 &&
    (checkpoint.nextChunk as number) <= totalChunks &&
    Array.isArray(checkpoint.parts) &&
    checkpoint.parts.length === checkpoint.nextChunk &&
    checkpoint.parts.every(part => typeof part === 'string') &&
    (checkpoint.segments === undefined || Array.isArray(checkpoint.segments));
}

async function makeAudioFileKey(file: File): Promise<string> {
  const identity = [file.name, file.size, file.lastModified, file.type].join('|');
  try {
    if (!globalThis.crypto?.subtle) return identity;
    const sampleSize = 64 * 1024;
    const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
    const tail = file.size > sampleSize ? new Uint8Array(await file.slice(Math.max(sampleSize, file.size - sampleSize)).arrayBuffer()) : new Uint8Array();
    const sample = new Uint8Array(head.length + tail.length);
    sample.set(head);
    sample.set(tail, head.length);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', sample);
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return identity + '|' + fingerprint;
  } catch { return identity; }
}

async function getAudioDurationSeconds(file: File): Promise<number> {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let settled = false;
    const timer = window.setTimeout(() => finish(new Error('Reading audio metadata took too long. Try MP3, M4A, WAV or OGG.')), 15000);
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.onabort = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      window.clearTimeout(timer);
    };
    const finish = (error?: Error, duration?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error('Could not read the recording duration. Try exporting the audio as MP3, M4A, WAV or OGG.'));
    };
    audio.onloadedmetadata = () => finish(undefined, audio.duration);
    audio.onerror = () => finish(new Error('This browser could not read the audio duration. Try Chrome or convert the recording to MP3, M4A, WAV or OGG.'));
    audio.onabort = () => finish(new Error('Reading audio metadata was interrupted. Please select the recording again.'));
    audio.src = url;
  });
}

function safeFileBaseName(value: string, fallback = 'aurora-transcript'): string {
  const cleaned = value.trim().replace(/\\.[a-z0-9]{1,8}$/i, '').replace(/[\\/:*?"<>|\\u0000-\\u001f]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 100);
  return cleaned || fallback;
}

function downloadFile(name: string, content: string | Blob, type: string) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function normalizeTranscriptForCompare(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function subtitleToVtt(value: string): string {
  const normalized = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const lines = normalized ? normalized.split('\n') : [];
  const header = lines.length && /^WEBVTT(?:\s|$)/i.test(lines[0]) ? lines.shift()! : 'WEBVTT';
  const converted = lines.map(line =>
    /^\s*\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(line)
      ? line.replace(/,(\d{3})/g, '.$1')
      : line
  );
  return [header, '', ...converted].join('\n').trimEnd() + '\n';
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
    if (cachedBlob.size > 5_000_000) {
      onProgress?.('Vosk backup model is already saved on this device.');
      return;
    }
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
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.length;
        if (total > 0) onProgress?.('Downloading Vosk model · ' + Math.min(100, Math.round(received / total * 100)) + '%');
      }
    }
    blob = new Blob(chunks, { type: 'application/gzip' });
  } else {
    blob = await response.blob();
  }
  if (blob.size < 5_000_000) throw new Error('The Vosk model download is incomplete. Please retry preparation.');
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
      } finally {
        URL.revokeObjectURL(modelUrl);
      }
    })().catch(error => { voskModelPromise = null; throw error; });
  }
  return voskModelPromise;
}

async function transcribeWithVosk(audio: Float32Array): Promise<string> {
  const model = await getVoskModel();
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext is unavailable.');
  const context = new AudioContextClass({ sampleRate: 16000 });
  const recognizer = new model.KaldiRecognizer();
  try {
    const buffer = context.createBuffer(1, audio.length, 16000);
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
      const maxTimer = window.setTimeout(() => finish(), 20000);
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
async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit, onRetry?: (attempt: number) => void): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(input, init);
      if (response.ok || !([408, 425, 429].includes(response.status) || response.status >= 500) || attempt === 3) return response;
      const retryAfter = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(30000, Math.max(800, retryAfterSeconds * 1000))
        : 800 * (2 ** attempt);
      onRetry?.(attempt + 1);
      await new Promise(resolve => window.setTimeout(resolve, waitMs));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      onRetry?.(attempt + 1);
    }
    await new Promise(resolve => window.setTimeout(resolve, 800 * (2 ** attempt)));
  }
  throw lastError instanceof Error ? lastError : new Error('Network request failed after retries.');
}

async function getWhisper(onProgress: (message: string) => void): Promise<Engine> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = true;
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
  onStatus: (message: string) => void,
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const inputPath = '/audio-input/' + file.name;
  const outputName = 'aurora-offline-current.wav';
  const parts: string[] = [];
  const segmentSeconds = Math.min(60, getAudioSegmentSeconds());
  const overlapSeconds = 2;
  const stepSeconds = Math.max(1, segmentSeconds - overlapSeconds);
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
    onStatus('Loading on-device audio decoder…');
    await ffmpeg.load({
      coreURL: await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.wasm', 'application/wasm'),
    });
    // Create the mount point before attaching the selected File to FFmpeg's virtual filesystem.
    await ffmpeg.createDir('/audio-input');
    const mounted = await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/audio-input');
    if (!mounted) throw new Error('This browser could not mount the audio file for section-by-section processing. Try Chrome or a smaller MP3/WAV recording.');
    const duration = await getAudioDurationSeconds(file);
    const total = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!total || total > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const fileKey = await makeAudioFileKey(file);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey); } catch { /* Continue without persistent resume. */ }
    const checkpoint: TranscriptionCheckpoint = isUsableCheckpoint(saved, total)
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, parts: [], nextChunk: 0, totalChunks: total };
    parts.push(...checkpoint.parts);
    onPart(parts.filter(Boolean));
    onProgress(checkpoint.nextChunk, total);
    for (let index = checkpoint.nextChunk; index < total; index++) {
      const start = index * stepSeconds;
      const length = Math.min(segmentSeconds, duration - start);
      onStatus('Preparing offline section ' + (index + 1) + ' of ' + total + '…');
      const decodeExitCode = await ffmpeg.exec([
        '-y', '-ss', String(start), '-t', String(length), '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-f', 'wav', outputName,
      ]);
      if (decodeExitCode !== 0) throw new Error('FFmpeg could not decode offline section ' + (index + 1) + ' (exit ' + decodeExitCode + '). Check the audio format or try MP3.');
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('The offline decoder returned invalid audio data.');
      const audio = pcmToFloat(output);
      if (audioRms(audio) < 0.0015) {
        parts.push('');
      } else {
        let transcript = '';
        let whisperProblem = '';
        try {
          onStatus('On-device Whisper · section ' + (index + 1) + ' of ' + total + '…');
          const whisper = await getWhisper(onStatus);
          const result = await whisper(audio, { sampling_rate: 16000, chunk_length_s: 30, stride_length_s: 5 });
          transcript = result.text?.trim() || '';
          if (!transcript) throw new Error('Whisper Tiny returned an empty result.');
        } catch (reason) {
          whisperProblem = reason instanceof Error ? reason.message : String(reason);
        }
        if (!transcript) {
          try {
            onStatus('Whisper Tiny unavailable. Trying Vosk offline · section ' + (index + 1) + ' of ' + total + '…');
            transcript = await transcribeWithVosk(audio);
          } catch (voskProblem) {
            throw new Error('Offline engines could not transcribe section ' + (index + 1) + '. Whisper: ' + whisperProblem + ' Vosk: ' + (voskProblem instanceof Error ? voskProblem.message : String(voskProblem)));
          }
        }
        parts.push(transcript);
      }
      checkpoint.parts = parts;
      checkpoint.nextChunk = index + 1;
      try { await writeSavedCheckpoint(fileKey, checkpoint); } catch { /* Keep in-session progress. */ }
      onProgress(index + 1, total);
      onPart(parts.filter(Boolean));
      try { await ffmpeg.deleteFile(outputName); } catch { /* The next write replaces this temporary file. */ }
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    if (!parts.some(Boolean)) throw new Error('No clear speech was detected in this recording.');
    try { await removeSavedCheckpoint(fileKey); } catch { /* Transcript is already available. */ }
    return parts.filter(Boolean);
  } finally {
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
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  const inputPath = '/audio-input/' + file.name;
  const outputName = 'aurora-online-current.mp3';
  const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)));
    }
    return btoa(binary);
  };
  try {
    await ffmpeg.load({
      coreURL: await toBlobURL(coreBase + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(coreBase + '/ffmpeg-core.wasm', 'application/wasm'),
    });
    // Create the mount point before attaching the selected File to FFmpeg's virtual filesystem.
    await ffmpeg.createDir('/audio-input');
    const mounted = await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/audio-input');
    if (!mounted) throw new Error('This browser could not mount the audio file for section-by-section processing. Try Chrome or a smaller MP3/WAV recording.');
    const duration = await getAudioDurationSeconds(file);
    const segmentSeconds = Math.min(90, getAudioSegmentSeconds()); // Adapt chunk size to device memory and CPU; small chunks keep Android Go working sets modest.
    const overlapSeconds = 2;
    const stepSeconds = Math.max(1, segmentSeconds - overlapSeconds);
    const totalParts = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!totalParts || totalParts > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const fileKey = await makeAudioFileKey(file);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey); } catch { /* Continue without persistent resume. */ }
    const checkpoint: TranscriptionCheckpoint = isUsableCheckpoint(saved, totalParts)
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, parts: [], nextChunk: 0, totalChunks: totalParts };
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
      const request = (url: string) => fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      let response: Response;
      try {
        response = await request(transcriptionApiUrl);
      } catch (primaryNetworkError) {
        if (!backupTranscriptionApiUrl) throw primaryNetworkError;
        response = await request(backupTranscriptionApiUrl);
      }
      let result = await response.json().catch(() => ({})) as { text?: string; error?: string; language?: string; language_name?: string; segments?: Array<{ start?: number; end?: number; text?: string; speaker_id?: string; speaker?: string }> };
      if (!response.ok && backupTranscriptionApiUrl && ([408, 425, 429].includes(response.status) || response.status >= 500)) {
        response = await request(backupTranscriptionApiUrl);
        result = await response.json().catch(() => ({})) as { text?: string; error?: string; language?: string; language_name?: string; segments?: Array<{ start?: number; end?: number; text?: string; speaker_id?: string; speaker?: string }> };
      }
      if (!response.ok) throw new Error(result.error || 'Transcription failed on audio section ' + (prepared.index + 1) + '.');
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('The transcription service returned an empty result for audio section ' + (prepared.index + 1) + '.');
      return { index: prepared.index, start: prepared.start, text: result.text.trim(), language: result.language_name || result.language || '', segments: result.segments ?? [] };
    };

    let checkpointStorageWarningShown = false;
    for (let index = checkpoint.nextChunk; index < totalParts; index++) {
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
      if (result.language) onStatus('Detected language: ' + result.language + ' · section ' + (index + 1) + ' of ' + totalParts);
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
        await writeSavedCheckpoint(fileKey, checkpoint);
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
    try { await removeSavedCheckpoint(fileKey); } catch { /* Completed transcript is already available. */ }
    return parts;
  } finally {
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

function App() {
  const [page, setPage] = useState<Page>('home');
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [library, setLibrary] = useState<Recording[]>(readLibrary);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<TranscriptionMode>('auto');
  const [offlinePrepBusy, setOfflinePrepBusy] = useState(false);
  const [offlinePrepStatus, setOfflinePrepStatus] = useState('');
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState('');
  const [exportType, setExportType] = useState('txt');
  const [exportFilename, setExportFilename] = useState('');
  const [voiceFilename, setVoiceFilename] = useState('aurora-voice');
  const [studioText, setStudioText] = useState('');
  const [voiceRate, setVoiceRate] = useState(1);
  const [voicePitch, setVoicePitch] = useState(1);
  const [voiceName, setVoiceName] = useState('nova');
  const [voiceStyle, setVoiceStyle] = useState('Natural, conversational delivery');
  const [voiceEmotion, setVoiceEmotion] = useState('Warm and friendly');
  const [voiceAccent, setVoiceAccent] = useState('International English');
  const [voiceEmphasis, setVoiceEmphasis] = useState('Natural emphasis');
  const [voicePauses, setVoicePauses] = useState('Natural pauses');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [assistBusy, setAssistBusy] = useState(false);
  const [voiceAudioUrl, setVoiceAudioUrl] = useState('');
  const [voiceProvider, setVoiceProvider] = useState('');
  const [audioPlayhead, setAudioPlayhead] = useState(0);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [subtitleQuery, setSubtitleQuery] = useState('');
  const [subtitleLanguage, setSubtitleLanguage] = useState('en');
  const [subtitleType, setSubtitleType] = useState<'movie' | 'episode' | undefined>(undefined);
  const [subtitleResults, setSubtitleResults] = useState<Array<{id:string;fileId:number|null;fileName:string;language:string;release:string;title:string;year:number|null;season?:number|null;episode?:number|null;hearingImpaired?:boolean;downloads:number}>>([]);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [subtitleTranslateLanguage, setSubtitleTranslateLanguage] = useState('English');
  const [transcriptTargetLanguage, setTranscriptTargetLanguage] = useState('English');
  const [translationBusy, setTranslationBusy] = useState(false);
  const [subtitleStatus, setSubtitleStatus] = useState('');
  const [subtitleText, setSubtitleText] = useState('');
  const [subtitleFilename, setSubtitleFilename] = useState('subtitle');
  const audioRef = useRef<HTMLAudioElement>(null);
  const [summary, setSummary] = useState('');
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<AudioFile[]>(files);
  filesRef.current = files;
  const active = files.find(item => item.id === activeId) ?? files[0] ?? null;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); } catch { /* Browser storage can be full or disabled. */ }
  }, [library]);

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

  function addFiles(list: FileList | null) {
    if (!list) return;
    const accepted = Array.from(list).filter(file => file.size > 0 && (file.type.startsWith('audio/') || /\.(opus|ogg|mp3|m4a|wav|aac|amr|3gp|webm)$/i.test(file.name)));
    if (!accepted.length) { setError('Choose an audio file such as OPUS, OGG, MP3, M4A or WAV.'); return; }
    const next = accepted.map(file => ({ id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), file, url: URL.createObjectURL(file), transcript: '' }));
    setFiles(current => [...current, ...next]);
    setActiveId(current => current ?? next[0].id);
    setError('');
  }


  async function prepareOfflineEngine() {
    if (offlinePrepBusy) return;
    setOfflinePrepBusy(true); setOfflinePrepStatus('Preparing Whisper Tiny, Vosk backup model and audio decoder…'); setError('');
    try {
      await getWhisper(message => setOfflinePrepStatus(message));
      await cacheVoskModel(message => setOfflinePrepStatus(message));
      const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
      const coreUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.js', 'text/javascript');
      const wasmUrl = await getCachedOfflineAssetUrl(coreBase + '/ffmpeg-core.wasm', 'application/wasm');
      URL.revokeObjectURL(coreUrl); URL.revokeObjectURL(wasmUrl);
      setOfflinePrepStatus('Offline engines prepared: Whisper Tiny + Vosk backup + audio decoder. Keep this app data and browser cache; first preparation needs internet.');
    } catch (reason) {
      setOfflinePrepStatus('Offline preparation failed. Connect to a stable network and retry.');
      setError(reason instanceof Error ? reason.message : 'Could not prepare the offline engine.');
    } finally { setOfflinePrepBusy(false); }
  }

  async function transcribe() {
    if (!active || busy) return;
    const selected = active;
    setBusy(true);
    setError('');
    setStatus('Preparing audio for section-by-section transcription…');
    setProgress({ completed: 0, total: 0 });
    const onPart = (parts: string[]) => {
      const partial = mergeTranscriptParts(parts);
      if (partial) setFiles(current => current.map(item => item.id === selected.id ? { ...item, transcript: partial } : item));
    };
    const onProgress = (completed: number, total: number, engine: string) => {
      setProgress({ completed, total });
      setStatus(engine + ' · completed ' + completed + ' of ' + total + ' sections…');
    };
    const runOffline = () => transcribeOpusOfflineInSegments(
      selected.file,
      (completed, total) => onProgress(completed, total, 'On-device transcription'),
      onPart,
      setStatus,
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
          parts = await transcribeOpusInSegments(
            selected.file,
            (completed, total) => onProgress(completed, total, 'Groq Whisper'),
            onPart,
            (segments) => setFiles(current => current.map(item => item.id === selected.id ? { ...item, timedSegments: segments } : item)),
            setStatus,
          );
        } catch (onlineProblem) {
          if (mode === 'online') throw onlineProblem;
          setStatus('Online transcription could not finish. Switching to on-device Whisper, then Vosk if needed…');
          try {
            parts = await runOffline();
          } catch (offlineProblem) {
            throw new Error(
              'Automatic transcription could not complete. Online: ' +
              (onlineProblem instanceof Error ? onlineProblem.message : String(onlineProblem)) +
              ' · Offline: ' +
              (offlineProblem instanceof Error ? offlineProblem.message : String(offlineProblem)),
            );
          }
        }
      }
      const completedText = mergeTranscriptParts(parts);
      if (!completedText) throw new Error('No clear speech was detected. Try a recording with clearer speech and less background noise.');
      setFiles(current => current.map(item => item.id === selected.id ? { ...item, transcript: completedText, translatedTranscript: '' } : item));
      setStatus(mode === 'offline'
        ? 'Offline transcription complete. Whisper automatically detects supported speech languages; review the original transcript.'
        : 'Transcription complete. Review the original-language transcript before translating.');
      setError('');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Transcription failed.';
      setError(message + ' Completed sections are checkpointed when browser storage is available. Tap Transcribe again with the same recording to resume.');
      setStatus('Your recording remains selected. You can retry without starting over from completed sections.');
    } finally {
      if (Capacitor.isNativePlatform()) await backgroundTranscription.stop().catch(() => undefined);
      setBusy(false);
    }
  }
  async function translateActiveTranscript() {
    if (!active?.transcript.trim() || translationBusy) return;
    setTranslationBusy(true);
    setError('');
    try {
      const { data } = await requestFeature('/api/translate', {
        text: active.transcript,
        targetLanguage: transcriptTargetLanguage,
        sourceLanguage: active.detectedLanguage || 'auto',
      });
      const translated = String(data?.text || '').trim();
      if (!translated) throw new Error('The translation service returned an empty result.');
      setFiles(current => current.map(item => item.id === active.id ? { ...item, translatedTranscript: translated } : item));
      setStatus('Translation ready · original transcript has been preserved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Translation failed. Check the translation service and try again.');
    } finally { setTranslationBusy(false); }
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
    const segmentTranscript = timedSegments?.length ? timedSegments.map(segment => segment.text).join(' ') : '';
    const timestampsCoverTranscript = Boolean(timedSegments?.length) &&
      normalizeTranscriptForCompare(segmentTranscript) === normalizeTranscriptForCompare(text);
    const timestamped = includeTimestamps && timestampsCoverTranscript
      ? timedSegments!.map(segment => '[' + new Date(segment.start * 1000).toISOString().slice(11,19) + '] ' + segment.text).join('\n')
      : text;
    if (exportType === 'docx') {
      try {
        const paragraphs = includeTimestamps && timestampsCoverTranscript
          ? timedSegments!.map(segment => new Paragraph({ children: [new TextRun({ text: '[' + new Date(segment.start * 1000).toISOString().slice(11,19) + '] ', bold: true, color: '167D91' }), new TextRun(segment.text)], spacing: { after: 120 } }))
          : text.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun(line)], spacing: { after: 120 } }));
        const doc = new Document({ sections: [{ properties: {}, children: [new Paragraph({ children: [new TextRun({ text: 'AURORA VoiceText Transcript', bold: true, size: 30 })], spacing: { after: 300 } }), ...paragraphs] }] });
        const blob = await Packer.toBlob(doc);
        downloadFile(fileBase + '.docx', blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        setError('');
        setStatus(includeTimestamps && timedSegments?.length && !timestampsCoverTranscript
          ? 'DOCX exported with the complete transcript. Timestamps were omitted because the timed segments did not cover all edited text.'
          : 'DOCX document prepared with the complete transcript.');
      } catch (error) { setError(error instanceof Error ? error.message : 'DOCX export failed.'); }
      return;
    }
    if (exportType === 'pdf') {
      const popup = window.open('', '_blank');
      if (!popup) { setError('Allow pop-ups to print or save as PDF.'); return; }
      popup.document.write('<!doctype html><html><head><title>AURORA VoiceText</title><style>body{font:16px Arial;line-height:1.7;max-width:760px;margin:40px auto;white-space:pre-wrap;padding:0 20px} @media print{body{margin:18mm auto}}</style></head><body></body></html>');
      popup.document.body.textContent = timestamped;
      popup.document.close(); popup.focus(); popup.print();
      return;
    }
    const extensions: Record<string, { ext: string; mime: string; text: string }> = {
      txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', text: timestamped },
      md: { ext: 'md', mime: 'text/markdown;charset=utf-8', text: '# AURORA VoiceText\n\n' + timestamped },
      html: { ext: 'html', mime: 'text/html;charset=utf-8', text: '<!doctype html><meta charset="utf-8"><title>AURORA VoiceText</title><pre style="white-space:pre-wrap;font:16px system-ui">' + timestamped.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char) ) + '</pre>' },
      rtf: { ext: 'rtf', mime: 'application/rtf', text: '{\\rtf1\\ansi ' + timestamped.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, '\\par ') + '}' },
      srt: { ext: 'srt', mime: 'application/x-subrip;charset=utf-8', text: timestampsCoverTranscript ? createTimedSubtitles(timedSegments!, 'srt') : createEstimatedSubtitles(text, 'srt') },
      vtt: { ext: 'vtt', mime: 'text/vtt;charset=utf-8', text: timestampsCoverTranscript ? createTimedSubtitles(timedSegments!, 'vtt') : createEstimatedSubtitles(text, 'vtt') },
    };
    const selected = extensions[exportType] ?? extensions.txt;
    downloadFile(fileBase + '.' + selected.ext, selected.text, selected.mime);
    if (exportType === 'srt' || exportType === 'vtt') setStatus(timestampsCoverTranscript ? 'Exported speech-aligned subtitle timing from the transcription engine.' : 'The timing data did not cover all transcript text; exported estimated timings so no words are omitted.');
    else if (includeTimestamps && timedSegments?.length && !timestampsCoverTranscript) setStatus('Exported the complete transcript without timestamps because the timing data did not cover all edited text.');
    else if (includeTimestamps && timestampsCoverTranscript) setStatus('Exported the complete transcript with timestamps.');
    setError('');
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus('Copied to clipboard.'); }
    catch { setError('Copy is unavailable in this browser. Select the text and copy it manually.'); }
  }

  async function polishTranscript() {
    if (!active?.transcript.trim()) { setError('Select a transcript with text first.'); return; }
    setAssistBusy(true); setError(''); setStatus('AI is polishing the transcript while preserving its meaning…');
    try {
      const chunks = splitLongText(active.transcript, 18000);
      const output: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        setStatus('Polishing section ' + (i + 1) + ' of ' + chunks.length + '…');
        const { data } = await requestFeature('/api/assist', { text: chunks[i] });
        if (!data?.text) throw new Error('The AI returned an empty transcript section.');
        output.push(data.text);
      }
      updateTranscript(output.join('\n\n'));
      setStatus('Transcript polished. Review the wording before saving or exporting.');
    } catch (error) { setError(error instanceof Error ? error.message : 'AI transcript polishing failed.'); setStatus(''); }
    finally { setAssistBusy(false); }
  }

  async function generateVoice() {
    if (!studioText.trim()) { setError('Enter text before generating AI speech.'); return; }
    if (voiceAudioUrl) URL.revokeObjectURL(voiceAudioUrl);
    setVoiceAudioUrl(''); setVoiceBusy(true); setError(''); setStatus('Generating AI voice…');
    try {
      // Keep provider requests small enough for common TTS limits and mobile memory.
      const chunks = splitLongText(studioText, 3500);
      const audioParts: Blob[] = [];
      const providers = new Set<string>();
      for (let index = 0; index < chunks.length; index++) {
        setStatus('Generating voice section ' + (index + 1) + ' of ' + chunks.length + '…');
        const { response } = await requestFeature('/api/tts', { text: chunks[index], voice: voiceName, style: voiceStyle + '. Accent / pronunciation preference: ' + voiceAccent + '. Emphasis: ' + voiceEmphasis + '. Pauses: ' + voicePauses, emotion: voiceEmotion, rate: voiceRate, pitch: voicePitch }, true);
        const provider = response.headers.get('X-AURORA-Provider');
        if (provider) providers.add(provider);
        const audioPart = await response.blob();
        if (!audioPart.size) throw new Error('The speech provider returned an empty audio section (' + (index + 1) + ').');
        audioParts.push(audioPart);
      }
      const finalAudio = await mergeMp3ChunksToWav(audioParts);
      setVoiceAudioUrl(URL.createObjectURL(finalAudio));
      setVoiceProvider([providers.size ? Array.from(providers).join(' + ') : 'AI speech provider', chunks.length > 1 ? 'merged ' + chunks.length + ' sections' : 'single section'].join(' · '));
      setStatus('AI voice generated. Preview it below, then download the complete WAV audio.');
    } catch (error) { setError(error instanceof Error ? error.message : 'AI voice generation failed.'); setStatus(''); }
    finally { setVoiceBusy(false); }
  }

  async function searchSubtitles() {
    if (subtitleQuery.trim().length < 2) { setError('Enter a film or episode title first.'); return; }
    setSubtitleBusy(true); setSubtitleStatus('Searching OpenSubtitles…'); setSubtitleResults([]); setError('');
    try {
      const { data } = await requestFeature('/api/subtitles', { query: subtitleQuery.trim(), languages: subtitleLanguage, type: subtitleType });
      setSubtitleResults(Array.isArray(data?.results) ? data.results : []);
      setSubtitleStatus(data?.results?.length ? 'Choose a matching subtitle release below.' : 'No matching subtitles were found. Try another title or language.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Subtitle search failed.'); setSubtitleStatus(''); }
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
      downloadFile(safeName + (translate ? '-' + subtitleTranslateLanguage.toLowerCase().replace(/\s+/g, '-') : '') + (vtt ? '.vtt' : '.srt'), exportText, vtt ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8');
      setSubtitleStatus(translate ? 'Translated subtitle exported. Review the timing and wording before use.' : 'Subtitle downloaded.');
    } catch (error) { setError(error instanceof Error ? error.message : 'Subtitle download or translation failed.'); setSubtitleStatus(''); }
    finally { setSubtitleBusy(false); }
  }

  function updateTimedSegment(index: number, value: string) {
    if (!active) return;
    const segments = [...(active.timedSegments || [])];
    if (!segments[index]) return;
    segments[index] = { ...segments[index], text: value };
    setFiles(current => current.map(item => item.id === active.id ? { ...item, timedSegments: segments, transcript: segments.map(segment => segment.text).join(' ') } : item));
  }

  const filteredLibrary = library.filter(item => (item.name + ' ' + item.transcript).toLowerCase().includes(search.toLowerCase()));

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setPage('home')} type="button" aria-label="AURORA VoiceText home">
          <span className="brand-mark"><AudioLines size={24} /></span>
          <span><strong>AURORA <i>VoiceText</i></strong><small>VOICE NOTES, MADE READABLE</small></span>
        </button>
        <span className="local-badge"><span /> FREE WORKSPACE</span>
      </header>

      <nav className="main-nav" aria-label="Main navigation">
        {([['home','Home',Sparkles],['transcribe','Transcribe',WandSparkles],['preview','AI Preview',AudioWaveform],['library','Library',BookOpen],['studio','Voice Studio',Mic2],['subtitles','Subtitle Finder',Languages],['settings','Settings',Settings2]] as const).map(([key,label,Icon]) =>
          <button key={key} type="button" className={page === key ? 'nav-link active' : 'nav-link'} onClick={() => { setPage(key); setError(''); }}><Icon size={16}/><span>{label}</span></button>
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
        <div className="info-strip"><ShieldCheck size={18}/><div><strong>Private by default</strong><p>Auto uses Groq Whisper first for better accuracy, then tries on-device Whisper Tiny and Vosk if the online service fails. Offline mode keeps audio on your device.</p></div></div>
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
            <button className="upload-box" type="button" onClick={() => inputRef.current?.click()}><span className="upload-symbol"><Upload/></span><strong>Choose audio files</strong><span>Browse your phone storage</span><small>OPUS · OGG · MP3 · M4A · WAV · AAC</small></button>
            <input ref={inputRef} className="hidden-input" type="file" accept="audio/*,.opus,.ogg,.mp3,.m4a,.wav,.aac,.amr,.3gp,.webm" multiple onChange={event => { addFiles(event.currentTarget.files); event.currentTarget.value = ''; }}/>
            <div className="recording-list">{files.map(item => <div key={item.id} className={active?.id === item.id ? 'recording-row selected' : 'recording-row'}><button className="recording-select" onClick={() => {setActiveId(item.id);setError('');}} type="button"><FileAudio size={18}/><span><strong>{item.file.name}</strong><small>{Math.max(1, Math.round(item.file.size / 1024))} KB · {item.transcript ? 'Transcript ready' : 'Not transcribed yet'}</small></span></button><button className="icon-button" aria-label={'Remove '+item.file.name} onClick={() => removeFile(item.id)} type="button"><X size={16}/></button></div>)}</div>
            {files.length > 0 && <button className="text-button" type="button" onClick={() => inputRef.current?.click()}><Plus size={16}/> Add more audio</button>}
            <p className="privacy-hint"><ShieldCheck size={15}/> Auto sends audio to Groq first, then uses on-device backups if needed. Offline never uploads audio. Online always uses Groq.</p>
          </section>
          <section className="card">
            <div className="card-title"><div><small>STEP 02</small><h2>Transcript editor</h2></div><span className="language-tag">AUTO LANGUAGE</span></div>
            {active ? <>
              <div className="active-file"><FileAudio size={16}/><span>{active.file.name}</span></div>
              <audio ref={audioRef} className="audio-player" controls preload="metadata" src={active.url} onTimeUpdate={event => setAudioPlayhead(event.currentTarget.currentTime)}/>

              <div className="mode-switch" role="group" aria-label="Transcription mode">
                <button className={mode === 'auto' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('auto'); setError(''); }}><Sparkles size={17}/><strong>Auto</strong><small>Groq first · offline backup</small></button>
                <button className={mode === 'offline' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('offline'); setError(''); }}><ShieldCheck size={17}/><strong>Offline</strong><small>Device only · Whisper → Vosk</small></button>
                <button className={mode === 'online' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('online'); setError(''); }}><span>☁️</span><strong>Online</strong><small>Groq Whisper</small></button>
              </div>
              {mode === 'auto' && <p className="mode-explainer"><strong>Recommended · Best available quality</strong><span>Tries Groq Whisper first. If the connection or API fails, AURORA switches to Whisper Tiny, then Vosk on your device. Online processing sends audio to the server.</span></p>}
              {mode === 'offline' && <><p className="mode-explainer"><strong>Private device processing</strong><span>Uses Whisper Tiny on this device. Prepare the model and decoder once while online; later offline runs can reuse cached assets. Vosk backup is included; Prepare offline engine downloads its model (about 41 MB) for this device.</span></p><button className="secondary full-button" type="button" disabled={busy || offlinePrepBusy} onClick={prepareOfflineEngine}>{offlinePrepBusy ? <LoaderCircle className="spin" size={16}/> : <Download size={16}/>} {offlinePrepBusy ? 'Preparing offline engine…' : 'Prepare offline engine'}</button>{offlinePrepStatus && <div className="status-message" role="status">{offlinePrepStatus}</div>}</>}{mode === 'online' && <p className="mode-explainer"><strong>Hosted transcription</strong><span>Uses Groq Whisper only. Your audio is sent securely to the configured transcription endpoint.</span></p>}
              <button className="primary full-button" disabled={busy} onClick={transcribe} type="button">{busy ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>} {busy ? 'Working…' : mode === 'auto' ? 'Transcribe automatically' : mode === 'online' ? 'Transcribe online' : 'Transcribe offline'}</button>
              {status && <div className="status-message" role="status">{status}</div>}
              {progress.total > 0 && <div className="progress-wrap" aria-label={'Transcription progress: ' + progress.completed + ' of ' + progress.total + ' sections'}><div className="progress-meta"><span>Section progress</span><strong>{Math.round((progress.completed / progress.total) * 100)}%</strong></div><div className="progress-track"><span style={{ width: (progress.completed / progress.total) * 100 + '%' }} /></div><small>{progress.completed} of {progress.total} sections completed · completed sections are saved on this device; reselect the same recording to resume</small></div>}
              <label className="field-label" htmlFor="transcript">Original transcript <small>{active.detectedLanguage ? 'Detected: ' + active.detectedLanguage : 'Language detection: automatic'}</small></label>
              <textarea id="transcript" className="transcript-input" value={active.transcript} onChange={event => updateTranscript(event.target.value)} placeholder="Speech will appear here in its original language. Review names and wording, then edit anything AURORA missed."/>
              <div className="translation-toolbar"><label className="field-label">Translate original into<select value={transcriptTargetLanguage} onChange={event => setTranscriptTargetLanguage(event.target.value)}><option>English</option><option>Yoruba</option><option>Igbo</option><option>Hausa</option><option>French</option><option>Spanish</option><option>Portuguese</option><option>Arabic</option><option>German</option><option>Chinese</option><option>Hindi</option><option>Swahili</option></select></label><button className="secondary" type="button" disabled={translationBusy || !active.transcript.trim()} onClick={translateActiveTranscript}>{translationBusy ? <LoaderCircle className="spin" size={16}/> : <Languages size={16}/>} {translationBusy ? 'Translating…' : 'Translate transcript'}</button></div>
              <label className="field-label" htmlFor="translated-transcript">Translated transcript</label>
              <textarea id="translated-transcript" className="transcript-input" value={active.translatedTranscript || ''} readOnly placeholder="The translation will appear here. Your original transcript stays unchanged."/>
              <div className="editor-tools"><span>{active.transcript.trim() ? active.transcript.trim().split(/\s+/).length : 0} words</span><button className="secondary small-button" type="button" onClick={saveToLibrary}><Save size={15}/> Save to library</button></div>
              <div className="summary-box"><div className="summary-head"><Sparkles size={16}/><strong>Quick key points</strong><button type="button" className="text-button" onClick={() => setSummary(makeSummary(active.transcript))}>Create summary</button></div><p>{summary || 'Create a short extractive summary from the current transcript. Review it before sharing.'}</p></div>
              <div className="editor-tools"><button className="secondary small-button" type="button" onClick={() => setPage('preview')}><AudioWaveform size={15}/> Open AI Preview & timestamps</button><label className="timestamp-toggle"><input type="checkbox" checked={includeTimestamps} onChange={event => setIncludeTimestamps(event.target.checked)}/> Include timestamps where available</label></div><div className="export-row"><label className="field-label" htmlFor="export-filename">File name<input id="export-filename" value={exportFilename || (active.file.name.replace(/\\.[^.]+$/, '') || 'transcript')} onChange={event => setExportFilename(event.target.value)} placeholder="Enter transcript filename"/></label><label className="field-label" htmlFor="export-type">Export format<select id="export-type" value={exportType} onChange={event => setExportType(event.target.value)}><option value="txt">Text (.txt)</option><option value="md">Markdown (.md)</option><option value="html">HTML (.html)</option><option value="rtf">Rich text (.rtf)</option><option value="docx">Word document (.docx)</option><option value="srt">Subtitles (.srt · speech timing when available)</option><option value="vtt">Web subtitles (.vtt · speech timing when available)</option><option value="pdf">Print / Save as PDF</option></select></label><button className="secondary" type="button" onClick={() => exportTranscript(active.transcript, active.file.name.replace(/\.[^.]+$/, '') || 'transcript', active.timedSegments)}><Download size={16}/> Export</button><button className="secondary" type="button" onClick={() => copyText(active.transcript)}><Copy size={16}/> Copy</button></div>
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
        <div className="page-heading"><div className="eyebrow">AI PREVIEW WORKSPACE</div><h1>Transcript preview</h1><p>Edit your transcript and its speech-aligned timestamps in one place. Changes stay attached to the selected recording.</p></div>
        {active ? <section className="card preview-card">
          <div className="card-title"><div><small>TRANSCRIPT WORKSPACE</small><h2>{active.file.name}</h2></div><span className="count">{active.timedSegments?.length || 0} timed lines</span></div>
          <audio ref={audioRef} className="audio-player" controls preload="metadata" src={active.url} onTimeUpdate={event => setAudioPlayhead(event.currentTarget.currentTime)}/>
          {active.timedSegments?.length ? <div className="preview-timeline">{active.timedSegments.map((segment,index)=><div className="preview-segment" key={index}><button type="button" className={audioPlayhead >= segment.start && audioPlayhead < segment.end ? "timestamp-chip active" : "timestamp-chip"} onClick={()=>{if(audioRef.current){audioRef.current.currentTime=segment.start;void audioRef.current.play();}}}>{Math.floor(segment.start/60).toString().padStart(2,'0')}:{Math.floor(segment.start%60).toString().padStart(2,'0')}</button><textarea value={(segment.speaker ? segment.speaker + ': ' : '') + segment.text} rows={2} onChange={event=>updateTimedSegment(index,event.target.value.replace(/^[^:]{1,30}:\s*/,''))} aria-label={'Edit transcript segment '+(index+1)}/></div>)}</div> : <><p className="privacy-hint">This recording has no speech-aligned segments. Edit the full transcript below; subtitle exports will use estimated timings.</p><textarea className="transcript-input" value={active.transcript} onChange={event=>updateTranscript(event.target.value)} aria-label="Edit transcript"/></>}
          <div className="studio-actions"><button className="primary" type="button" disabled={assistBusy} onClick={polishTranscript}>{assistBusy?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>} AI polish transcript</button><button className="primary" type="button" onClick={saveToLibrary}><Save size={16}/> Save changes</button><button className="secondary" type="button" onClick={()=>exportTranscript(active.transcript,active.file.name.replace(/\.[^.]+$/,'')||'transcript',active.timedSegments)}><Download size={16}/> Export transcript</button></div>
        </section> : <div className="empty-state"><AudioWaveform/><strong>Select a recording first</strong><span>Open Transcribe and choose a recording to edit its transcript.</span><button className="primary" onClick={()=>setPage('transcribe')} type="button">Open Transcribe</button></div>}
      </section>}

      {page === 'studio' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">AI VOICE STUDIO</div><h1>Give your words a voice.</h1><p>Generate downloadable AI speech, preview it, and export a single WAV file, including longer scripts processed in sections.</p></div>
        <section className="card studio-card">
          <div className="studio-icon"><Volume2 size={23}/></div>
          <label className="field-label" htmlFor="voice-filename">Audio file name<input id="voice-filename" value={voiceFilename} onChange={event=>setVoiceFilename(event.target.value)} placeholder="Enter audio filename"/></label>
          <label className="field-label" htmlFor="studio-text">Script / text</label>
          <textarea id="studio-text" className="transcript-input studio-input" value={studioText} onChange={event => setStudioText(event.target.value)} placeholder="Paste a script or choose a transcript from your library…"/>
          <div className="studio-grid">
            <label className="field-label">AI voice<select value={voiceName} onChange={event=>setVoiceName(event.target.value)}><option value="nova">Nova · feminine, bright</option><option value="shimmer">Shimmer · feminine, clear</option><option value="coral">Coral · feminine, warm</option><option value="sage">Sage · feminine, measured</option><option value="onyx">Onyx · masculine, deep</option><option value="echo">Echo · masculine, clear</option><option value="ash">Ash · masculine, conversational</option><option value="fable">Fable · expressive narrator</option><option value="alloy">Alloy · neutral</option></select></label>
            <label className="field-label">Delivery style<select value={voiceStyle} onChange={event=>setVoiceStyle(event.target.value)}><option>Natural, conversational delivery</option><option>Professional presenter, polished and confident</option><option>Storytelling, expressive and vivid</option><option>Documentary narrator, steady and authoritative</option><option>Energetic, upbeat and engaging</option><option>Calm, gentle and reassuring</option></select></label>
            <label className="field-label">Emotion<select value={voiceEmotion} onChange={event=>setVoiceEmotion(event.target.value)}><option>Warm and friendly</option><option>Neutral and informative</option><option>Excited and enthusiastic</option><option>Serious and thoughtful</option><option>Hopeful and inspiring</option></select></label>
            <label className="field-label">Accent / pronunciation<select value={voiceAccent} onChange={event=>setVoiceAccent(event.target.value)}><option>International English</option><option>British English</option><option>American English</option><option>Nigerian English</option><option>West African English</option><option>Australian English</option></select></label>
            <label className="field-label">Emphasis<select value={voiceEmphasis} onChange={event=>setVoiceEmphasis(event.target.value)}><option>Natural emphasis</option><option>Subtle emphasis</option><option>Expressive emphasis</option><option>Strong key-word emphasis</option></select></label>
            <label className="field-label">Pauses<select value={voicePauses} onChange={event=>setVoicePauses(event.target.value)}><option>Natural pauses</option><option>Short pauses</option><option>Long storytelling pauses</option><option>Presenter pacing</option></select></label>
          </div>
          <div className="sliders"><label>Speed <strong>{voiceRate.toFixed(1)}×</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voiceRate} onChange={event=>setVoiceRate(Number(event.target.value))}/></label><label>Pitch preference <strong>{voicePitch.toFixed(1)}</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voicePitch} onChange={event=>setVoicePitch(Number(event.target.value))}/></label></div>
          <div className="studio-actions"><button className="primary" type="button" disabled={voiceBusy} onClick={generateVoice}>{voiceBusy?<LoaderCircle className="spin" size={17}/>:<AudioWaveform size={17}/>} {voiceBusy?'Generating AI audio…':'Generate AI voice'}</button><button className="secondary" type="button" onClick={()=>{setStudioText('');if(voiceAudioUrl)URL.revokeObjectURL(voiceAudioUrl);setVoiceAudioUrl('');}}>Clear</button></div>
          {status && <div className="status-message" role="status">{status}</div>}
          {voiceAudioUrl && <div className="generated-audio"><strong>AI-generated audio · {voiceProvider}</strong><audio controls preload="metadata" src={voiceAudioUrl}/><a className="primary download-link" href={voiceAudioUrl} download={safeFileBaseName(voiceFilename, 'aurora-voice') + '.wav'}><Download size={16}/> Download WAV audio</a></div>}
          <p className="privacy-hint"><ShieldCheck size={15}/> Uses the configured AI speech provider, not your phone's built-in speech synthesis. API credentials remain on the server. Voice options depend on provider support.</p>
        </section>
      </section>}

      {page === 'subtitles' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">SUBTITLE FINDER</div><h1>Find subtitles for a video.</h1><p>Search available subtitle releases, download an authorized file, translate it, and export SRT or VTT.</p></div>
        <section className="card subtitle-card">
          <label className="field-label" htmlFor="subtitle-query">Movie or episode title<input id="subtitle-query" value={subtitleQuery} onChange={event=>setSubtitleQuery(event.target.value)} placeholder="Enter a film or series title"/></label>
          <div className="studio-grid"><label className="field-label">Content type<select value={subtitleType || 'all'} onChange={event=>setSubtitleType(event.target.value === 'all' ? undefined : event.target.value as 'movie' | 'episode')}><option value="all">Movies & series</option><option value="movie">Movie</option><option value="episode">TV episode</option></select></label><label className="field-label">Subtitle language<select value={subtitleLanguage} onChange={event=>setSubtitleLanguage(event.target.value)}><option value="en">English</option><option value="yo">Yoruba</option><option value="ig">Igbo</option><option value="ha">Hausa</option><option value="fr">French</option><option value="es">Spanish</option><option value="pt">Portuguese</option><option value="ar">Arabic</option><option value="de">German</option></select></label><label className="field-label">Translate to<select value={subtitleTranslateLanguage} onChange={event=>setSubtitleTranslateLanguage(event.target.value)}><option>English</option><option>Yoruba</option><option>Igbo</option><option>Hausa</option><option>French</option><option>Spanish</option><option>Portuguese</option><option>Arabic</option></select></label></div>
          <button className="primary full-button" disabled={subtitleBusy} onClick={searchSubtitles} type="button">{subtitleBusy?<LoaderCircle className="spin" size={17}/>:<Search size={17}/>} Search subtitle catalogue</button>
          {subtitleStatus && <div className="status-message" role="status">{subtitleStatus}</div>}
          {subtitleResults.length>0 && <div className="subtitle-results">{subtitleResults.map((item,index)=><article className="subtitle-result" key={item.id+'-'+index}><div><strong>{item.title} {item.year?'('+item.year+')':''}</strong><p>{item.language.toUpperCase()} · {item.release||item.fileName}{item.season ? ' · S'+String(item.season).padStart(2,'0')+(item.episode ? ' E'+String(item.episode).padStart(2,'0') : '') : ''} · {item.downloads.toLocaleString()} downloads{item.hearingImpaired ? ' · SDH' : ''}</p></div><div className="subtitle-actions"><button className="secondary small-button" disabled={subtitleBusy||!item.fileId} onClick={()=>downloadSubtitle(item.fileId!,false,item.fileName)} type="button"><Download size={14}/> Download</button><button className="primary small-button" disabled={subtitleBusy||!item.fileId} onClick={()=>downloadSubtitle(item.fileId!,true,item.fileName)} type="button"><Languages size={14}/> Translate & export</button></div></article>)}</div>}
          {subtitleText && <div className="subtitle-preview"><strong>Last subtitle output · {subtitleFilename}</strong><textarea value={subtitleText} onChange={event=>setSubtitleText(event.target.value)} rows={8}/><div className="studio-actions"><button className="secondary" onClick={()=>downloadFile(subtitleFilename+'.srt',subtitleText,'application/x-subrip;charset=utf-8')} type="button"><FileDown size={15}/> Export SRT</button><button className="secondary" onClick={()=>downloadFile(subtitleFilename+'.vtt',subtitleToVtt(subtitleText),'text/vtt;charset=utf-8')} type="button"><FileDown size={15}/> Export VTT</button></div></div>}
          <p className="privacy-hint"><ShieldCheck size={15}/> Uses the configured OpenSubtitles catalogue. AURORA does not invent missing subtitle files. Translation needs a configured AI text provider.</p>
        </section>
      </section>}

      {page === 'settings' && <section className="page-content"><div className="page-heading"><div className="eyebrow">PREFERENCES</div><h1>Settings & privacy</h1><p>Understand what runs on your device and manage your saved text.</p></div><section className="card settings-card"><div className="setting-row"><span className="setting-icon"><ShieldCheck/></span><div><strong>On-device transcription</strong><p>Whisper Tiny runs in your browser after its model downloads. The first run requires internet, and low-memory phones may struggle with long audio.</p></div></div><div className="setting-row"><span className="setting-icon"><BookOpen/></span><div><strong>Local transcript library</strong><p>{library.length} saved transcript(s). Text is stored in this browser’s local storage, not synced to another device. Clearing browser data can erase it.</p></div><button className="secondary small-button" onClick={() => {if (window.confirm('Delete all saved transcripts from this browser?')) setLibrary([]);}} type="button"><Trash2 size={15}/> Clear library</button></div><div className="setting-row"><span className="setting-icon"><Mic2/></span><div><strong>Voice Studio</strong><p>Uses the configured AI speech API (OpenAI or ElevenLabs) and supports downloadable audio. Browser voices are not labelled as AI generation.</p></div></div><div className="setting-row"><span className="setting-icon"><Download/></span><div><strong>Export your work</strong><p>Export complete transcripts as TXT, Markdown, HTML, RTF, DOCX, SRT, VTT or PDF. Speech-aligned timestamps are included when available. Export files are created on your device.</p></div></div></section></section>}

      {error && <div className="error-message" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error" type="button"><X size={16}/></button></div>}
      <footer className="footer"><span><AudioLines size={15}/> AURORA VoiceText</span><span><ShieldCheck size={14}/> Local-first workspace</span><span><Clock3 size={14}/> English + Nigerian Pidgin · review results</span></footer>
    </main>
  );
}

export default App;
