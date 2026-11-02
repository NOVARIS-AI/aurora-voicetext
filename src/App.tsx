import { useEffect, useMemo, useRef, useState } from 'react';
import { createEstimatedSubtitles, mergeTranscriptParts } from './audio-utils';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import {
  AudioLines, Upload, FileAudio, X, Copy, Download, Plus, Sparkles,
  ShieldCheck, Clock3, Check, WandSparkles, LoaderCircle, FileText,
  Settings2, Mic2, Volume2, BookOpen, Trash2, Play, Pause, Save,
} from 'lucide-react';

type Recording = { id: string; name: string; transcript: string; updatedAt: number };
type AudioFile = { id: string; file: File; url: string; transcript: string };
type Page = 'home' | 'transcribe' | 'library' | 'studio' | 'settings';
type Engine = (audio: Float32Array, options: { sampling_rate: number; chunk_length_s?: number; stride_length_s?: number }) => Promise<{ text?: string }>;
type TranscriptionMode = 'auto' | 'offline' | 'online';
type TranscriptionCheckpoint = { fileId: string; parts: string[]; nextChunk: number; totalChunks: number };

const STORAGE_KEY = 'aurora-voicetext-library-v2';
const API_BASE_URL = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || '').replace(/\/+$/, '');
const transcriptionApiUrl = `${API_BASE_URL}/api/transcribe`;
let pipelinePromise: Promise<Engine> | null = null;
let voskModelPromise: Promise<any> | null = null;

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

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function makeSummary(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
  if (!sentences.length) return '';
  const keywords = new Set(['need', 'must', 'please', 'tomorrow', 'today', 'meeting', 'remember', 'send', 'call', 'pay', 'deadline', 'important', 'because', 'decide', 'agree', 'follow']);
  const ranked = sentences.map((sentence, index) => ({
    sentence, index,
    score: (sentence.split(/\s+/).length > 4 ? 1 : 0) +
      (sentence.match(/\b(?:need|must|please|tomorrow|today|meeting|remember|send|call|pay|deadline|important|decide|agree|follow)\b/gi) || []).length * 2,
  }));
  return ranked.sort((a, b) => b.score - a.score).slice(0, Math.min(4, ranked.length)).sort((a, b) => a.index - b.index).map(item => '• ' + item.sentence).join('\n');
}


async function transcribeWithVosk(audio: Float32Array): Promise<string> {
  const modelUrl = import.meta.env.VITE_VOSK_MODEL_URL as string | undefined;
  if (!modelUrl) throw new Error('Vosk model URL is not configured.');
  if (!voskModelPromise) {
    voskModelPromise = (async () => {
      const vosk = await import('vosk-browser');
      return vosk.createModel(modelUrl);
    })().catch(error => { voskModelPromise = null; throw error; });
  }
  const model = await voskModelPromise;
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext is unavailable.');
  const context = new AudioContextClass({ sampleRate: 16000 });
  const recognizer = new model.KaldiRecognizer();
  try {
    const buffer = context.createBuffer(1, audio.length, 16000);
    buffer.copyToChannel(audio, 0);
    const transcript = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish(''), 6000);
      const finish = (value: string, error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      recognizer.on('result', (message: any) => finish(message.result?.text?.trim() || ''));
      recognizer.acceptWaveform(buffer);
    });
    if (!transcript) throw new Error('Vosk returned no final speech segment.');
    return transcript;
  } finally {
    recognizer.remove();
    await context.close();
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

async function transcribeOnline(audio: Float32Array, index: number, total: number): Promise<string> {
  const response = await fetchWithRetry(transcriptionApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64: wavChunkToBase64(audio, 16000), mimeType: 'audio/wav', chunkNumber: index + 1, totalChunks: total, languageHint: 'English and Nigerian Pidgin' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Online transcription returned HTTP ' + response.status);
  const transcript = typeof data.text === 'string' ? data.text.trim() : '';
  if (!transcript) throw new Error('Groq returned an empty transcript for this audio section.');
  return transcript;
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

function wavChunkToBase64(audio: Float32Array, sampleRate = 16000): string {
  const buffer = new ArrayBuffer(44 + audio.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + audio.length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const blockSize = 0x8000;
  for (let i = 0; i < bytes.length; i += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + blockSize, bytes.length)));
  }
  return btoa(binary);
}

async function transcribeOpusOfflineInSegments(
  file: File,
  onProgress: (completed: number, total: number) => void,
  onPart: (parts: string[]) => void,
  onStatus: (message: string) => void,
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
  const extension = (file.name.split('.').pop() || 'opus').toLowerCase().replace(/[^a-z0-9]/g, '') || 'opus';
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
      coreURL: await toBlobURL(coreBase + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(coreBase + '/ffmpeg-core.wasm', 'application/wasm'),
    });
    // WORKERFS reads the selected File directly instead of copying the entire recording into WASM memory.
    await ffmpeg.mount('WORKERFS', { files: [file] }, '/audio-input');
    const duration = await getAudioDurationSeconds(file);
    const total = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!total || total > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const fileKey = await makeAudioFileKey(file);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey); } catch { /* Continue without persistent resume. */ }
    const checkpoint: TranscriptionCheckpoint = saved && saved.totalChunks === total
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, parts: [], nextChunk: 0, totalChunks: total };
    parts.push(...checkpoint.parts);
    onPart(parts.filter(Boolean));
    onProgress(checkpoint.nextChunk, total);
    for (let index = checkpoint.nextChunk; index < total; index++) {
      const start = index * stepSeconds;
      const length = Math.min(segmentSeconds, duration - start);
      onStatus('Preparing offline section ' + (index + 1) + ' of ' + total + '…');
      await ffmpeg.exec([
        '-y', '-ss', String(start), '-t', String(length), '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-f', 'wav', outputName,
      ]);
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
): Promise<string[]> {
  const ffmpeg = new FFmpeg();
  const coreBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
  const extension = (file.name.split('.').pop() || 'opus').toLowerCase().replace(/[^a-z0-9]/g, '') || 'opus';
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
    // WORKERFS avoids loading a second full copy of long recordings into the WASM filesystem.
    await ffmpeg.mount('WORKERFS', { files: [file] }, '/audio-input');
    const duration = await getAudioDurationSeconds(file);
    const segmentSeconds = Math.min(90, getAudioSegmentSeconds());
    const overlapSeconds = 2;
    const stepSeconds = Math.max(1, segmentSeconds - overlapSeconds);
    const totalParts = Math.max(1, Math.ceil((duration - overlapSeconds) / stepSeconds));
    if (!totalParts || totalParts > 2000) throw new Error('This recording is too long for the current browser session. Split it into smaller files and try again.');
    const fileKey = await makeAudioFileKey(file);
    let saved: TranscriptionCheckpoint | null = null;
    try { saved = await readSavedCheckpoint(fileKey); } catch { /* Continue without persistent resume. */ }
    const checkpoint: TranscriptionCheckpoint = saved && saved.totalChunks === totalParts
      ? { ...saved, fileId: fileKey }
      : { fileId: fileKey, parts: [], nextChunk: 0, totalChunks: totalParts };
    const parts: string[] = [...checkpoint.parts];
    onPart(parts);
    onProgress(checkpoint.nextChunk, totalParts);
    for (let index = checkpoint.nextChunk; index < totalParts; index++) {
      const start = index * stepSeconds;
      const length = Math.min(segmentSeconds, duration - start);
      await ffmpeg.exec([
        '-y', '-ss', String(start), '-t', String(length), '-i', inputPath,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', outputName,
      ]);
      const output = await ffmpeg.readFile(outputName);
      if (typeof output === 'string') throw new Error('The audio decoder returned invalid section data.');
      const bytes = output;
      if (!bytes.length) throw new Error('The audio decoder created an empty section.');
      if (bytes.length > 1250000) throw new Error('Audio section ' + (index + 1) + ' is too large to upload safely. Reduce the section length and retry.');
      const response = await fetchWithRetry(transcriptionApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: toBase64(bytes),
          mimeType: 'audio/mpeg',
          chunkNumber: index + 1,
          totalChunks: totalParts,
          languageHint: 'English and Nigerian Pidgin',
        }),
      });
      const result = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Transcription failed on audio section ' + (index + 1) + '.');
      if (typeof result.text === 'string' && result.text.trim()) parts.push(result.text.trim());
      else throw new Error('The transcription service returned an empty result for section ' + (index + 1) + '.');
      checkpoint.parts = parts;
      checkpoint.nextChunk = index + 1;
      try { await writeSavedCheckpoint(fileKey, checkpoint); } catch { /* Keep in-session partial transcript. */ }
      onProgress(index + 1, totalParts);
      onPart(parts);
      try { await ffmpeg.deleteFile(outputName); } catch { /* Ignore absent temporary output. */ }
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
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState('');
  const [exportType, setExportType] = useState('txt');
  const [studioText, setStudioText] = useState('');
  const [voiceRate, setVoiceRate] = useState(1);
  const [voicePitch, setVoicePitch] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [summary, setSummary] = useState('');
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<AudioFile[]>(files);
  filesRef.current = files;
  const active = files.find(item => item.id === activeId) ?? files[0] ?? null;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); } catch { /* Browser storage can be full or disabled. */ }
  }, [library]);

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
      setFiles(current => current.map(item => item.id === selected.id ? { ...item, transcript: completedText } : item));
      setStatus(mode === 'offline'
        ? 'Offline transcription complete. Audio was processed on this device.'
        : 'Transcription complete. Review names, numbers and Nigerian Pidgin before sharing.');
      setError('');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Transcription failed.';
      setError(message + ' Completed sections are checkpointed when browser storage is available. Tap Transcribe again with the same recording to resume.');
      setStatus('Your recording remains selected. You can retry without starting over from completed sections.');
    } finally {
      setBusy(false);
    }
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

  function exportTranscript(text: string, baseName = 'aurora-voicetext-transcript') {
    if (!text.trim()) { setError('There is no transcript to export yet.'); return; }
    if (exportType === 'pdf') {
      const popup = window.open('', '_blank');
      if (!popup) { setError('Allow pop-ups to print or save as PDF.'); return; }
      popup.document.write('<!doctype html><html><head><title>AURORA VoiceText</title><style>body{font:16px Arial;line-height:1.7;max-width:760px;margin:40px auto;white-space:pre-wrap;padding:0 20px}</style></head><body></body></html>');
      popup.document.body.textContent = text;
      popup.document.close(); popup.focus(); popup.print();
      return;
    }
    const extensions: Record<string, { ext: string; mime: string; text: string }> = {
      txt: { ext: 'txt', mime: 'text/plain;charset=utf-8', text },
      md: { ext: 'md', mime: 'text/markdown;charset=utf-8', text: '# AURORA VoiceText\n\n' + text },
      html: { ext: 'html', mime: 'text/html;charset=utf-8', text: '<!doctype html><meta charset="utf-8"><title>AURORA VoiceText</title><pre style="white-space:pre-wrap;font:16px system-ui">' + text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || char) ) + '</pre>' },
      rtf: { ext: 'rtf', mime: 'application/rtf', text: '{\\rtf1\\ansi ' + text.replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\n/g, '\\par ') + '}' },
      srt: { ext: 'srt', mime: 'application/x-subrip;charset=utf-8', text: createEstimatedSubtitles(text, 'srt') },
      vtt: { ext: 'vtt', mime: 'text/vtt;charset=utf-8', text: createEstimatedSubtitles(text, 'vtt') },
    };
    const selected = extensions[exportType] ?? extensions.txt;
    downloadFile(baseName + '.' + selected.ext, selected.text, selected.mime);
    if (exportType === 'srt' || exportType === 'vtt') setStatus('Subtitle timings are estimates based on word count, not speech-aligned timestamps.');
    setError('');
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); setStatus('Copied to clipboard.'); }
    catch { setError('Copy is unavailable in this browser. Select the text and copy it manually.'); }
  }

  function speak() {
    if (!('speechSynthesis' in window)) { setError('Text-to-speech is not supported in this browser.'); return; }
    if (playing) { window.speechSynthesis.cancel(); setPlaying(false); return; }
    if (!studioText.trim()) { setError('Enter some text for Voice Studio first.'); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(studioText);
    utterance.rate = voiceRate; utterance.pitch = voicePitch;
    utterance.onend = () => setPlaying(false);
    utterance.onerror = () => setPlaying(false);
    setPlaying(true); window.speechSynthesis.speak(utterance);
  }

  const allText = useMemo(() => files.filter(item => item.transcript.trim()).map(item => item.file.name + '\n' + item.transcript.trim()).join('\n\n──────────────\n\n'), [files]);
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
        {([['home','Home',Sparkles],['transcribe','Transcribe',WandSparkles],['library','Library',BookOpen],['studio','Voice Studio',Mic2],['settings','Settings',Settings2]] as const).map(([key,label,Icon]) =>
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
          <button onClick={() => setPage('studio')} type="button"><Volume2/><strong>Voice Studio</strong><span>Read text aloud with your device voice.</span></button>
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
            <div className="card-title"><div><small>STEP 02</small><h2>Transcript editor</h2></div><span className="language-tag">EN + PIDGIN</span></div>
            {active ? <>
              <div className="active-file"><FileAudio size={16}/><span>{active.file.name}</span></div>
              <audio className="audio-player" controls preload="metadata" src={active.url}/>
              <div className="mode-switch" role="group" aria-label="Transcription mode">
                <button className={mode === 'auto' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('auto'); setError(''); }}><Sparkles size={17}/><strong>Auto</strong><small>Groq first · offline backup</small></button>
                <button className={mode === 'offline' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('offline'); setError(''); }}><ShieldCheck size={17}/><strong>Offline</strong><small>Device only · Whisper → Vosk</small></button>
                <button className={mode === 'online' ? 'mode-option selected' : 'mode-option'} type="button" disabled={busy} onClick={() => { setMode('online'); setError(''); }}><span>☁️</span><strong>Online</strong><small>Groq Whisper</small></button>
              </div>
              {mode === 'auto' && <p className="mode-explainer"><strong>Recommended · Best available quality</strong><span>Tries Groq Whisper first. If the connection or API fails, AURORA switches to Whisper Tiny, then Vosk on your device. Online processing sends audio to the server.</span></p>}
              {mode === 'offline' && <p className="mode-explainer"><strong>Private device processing</strong><span>Uses Whisper Tiny, then Vosk if a compatible Vosk model is configured. The first model download needs internet.</span></p>}{mode === 'online' && <p className="mode-explainer"><strong>Hosted transcription</strong><span>Uses Groq Whisper only. Your audio is sent securely to the configured transcription endpoint.</span></p>}
              <button className="primary full-button" disabled={busy} onClick={transcribe} type="button">{busy ? <LoaderCircle className="spin" size={17}/> : <WandSparkles size={17}/>} {busy ? 'Working…' : mode === 'auto' ? 'Transcribe automatically' : mode === 'online' ? 'Transcribe online' : 'Transcribe offline'}</button>
              {status && <div className="status-message" role="status">{status}</div>}
              {progress.total > 0 && <div className="progress-wrap" aria-label={'Transcription progress: ' + progress.completed + ' of ' + progress.total + ' sections'}><div className="progress-meta"><span>Section progress</span><strong>{Math.round((progress.completed / progress.total) * 100)}%</strong></div><div className="progress-track"><span style={{ width: (progress.completed / progress.total) * 100 + '%' }} /></div><small>{progress.completed} of {progress.total} sections completed · completed sections are saved on this device; reselect the same recording to resume</small></div>}
              <label className="field-label" htmlFor="transcript">Transcript text</label>
              <textarea id="transcript" className="transcript-input" value={active.transcript} onChange={event => updateTranscript(event.target.value)} placeholder="Your words will appear here. Review names, numbers and Pidgin, then edit anything AURORA missed."/>
              <div className="editor-tools"><span>{active.transcript.trim() ? active.transcript.trim().split(/\s+/).length : 0} words</span><button className="secondary small-button" type="button" onClick={saveToLibrary}><Save size={15}/> Save to library</button></div>
              <div className="summary-box"><div className="summary-head"><Sparkles size={16}/><strong>Quick key points</strong><button type="button" className="text-button" onClick={() => setSummary(makeSummary(active.transcript))}>Create summary</button></div><p>{summary || 'Create a short extractive summary from the current transcript. Review it before sharing.'}</p></div>
              <div className="export-row"><label className="field-label" htmlFor="export-type">Export format<select id="export-type" value={exportType} onChange={event => setExportType(event.target.value)}><option value="txt">Text (.txt)</option><option value="md">Markdown (.md)</option><option value="html">HTML (.html)</option><option value="rtf">Rich text (.rtf)</option><option value="srt">Subtitles (.srt · estimated timing)</option><option value="vtt">Web subtitles (.vtt · estimated timing)</option><option value="pdf">Print / Save as PDF</option></select></label><button className="secondary" type="button" onClick={() => exportTranscript(active.transcript, active.file.name.replace(/\.[^.]+$/, '') || 'transcript')}><Download size={16}/> Export</button><button className="secondary" type="button" onClick={() => copyText(active.transcript)}><Copy size={16}/> Copy</button></div>
            </> : <div className="empty-state"><FileAudio size={30}/><strong>No recording selected</strong><span>Choose an audio file to begin, or paste text in a saved library item.</span></div>}
          </section>
        </div>
      </section>}

      {page === 'library' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">YOUR NOTES</div><h1>Transcript library</h1><p>Saved text stays in this browser on this device. Audio files themselves are not stored here.</p></div>
        <div className="library-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search saved transcripts"/></label><span className="count">{filteredLibrary.length} saved</span></div>
        {filteredLibrary.length ? <div className="library-grid">{filteredLibrary.map(item => <article className="library-card" key={item.id}><div className="library-card-head"><span className="library-icon"><FileText size={18}/></span><button className="icon-button" aria-label="Delete saved transcript" onClick={() => setLibrary(current => current.filter(entry => entry.id !== item.id))} type="button"><Trash2 size={16}/></button></div><h3>{item.name}</h3><small>Saved {new Date(item.updatedAt).toLocaleDateString()}</small><p>{item.transcript.slice(0, 240)}{item.transcript.length > 240 ? '…' : ''}</p><div className="library-actions"><button className="secondary small-button" onClick={() => {setStudioText(item.transcript);setPage('studio');}} type="button"><Volume2 size={15}/> Read aloud</button><button className="secondary small-button" onClick={() => exportTranscript(item.transcript, item.name.replace(/\.[^.]+$/, '') || 'transcript')} type="button"><Download size={15}/> Export</button><button className="text-button" onClick={() => copyText(item.transcript)} type="button"><Copy size={15}/> Copy</button></div></article>)}</div> : <div className="empty-state library-empty"><BookOpen size={32}/><strong>Your library is empty</strong><span>Transcribe or paste a voice note, then tap Save to library.</span><button className="primary" onClick={() => setPage('transcribe')} type="button">Go to transcribe</button></div>}
      </section>}

      {page === 'studio' && <section className="page-content">
        <div className="page-heading"><div className="eyebrow">VOICE STUDIO</div><h1>Listen to your text</h1><p>Use the speech voices available on your phone or browser. Voice availability varies by device.</p></div>
        <section className="card studio-card"><div className="studio-icon"><Volume2 size={23}/></div><label className="field-label" htmlFor="studio-text">Text to read aloud</label><textarea id="studio-text" className="transcript-input studio-input" value={studioText} onChange={event => setStudioText(event.target.value)} placeholder="Paste a message or choose a transcript from your library…"/><div className="sliders"><label>Speed <strong>{voiceRate.toFixed(1)}×</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voiceRate} onChange={event => setVoiceRate(Number(event.target.value))}/></label><label>Pitch <strong>{voicePitch.toFixed(1)}</strong><input type="range" min="0.7" max="1.3" step="0.1" value={voicePitch} onChange={event => setVoicePitch(Number(event.target.value))}/></label></div><div className="studio-actions"><button className="primary" onClick={speak} type="button">{playing ? <Pause size={17}/> : <Play size={17}/>} {playing ? 'Stop reading' : 'Read aloud'}</button><button className="secondary" onClick={() => setStudioText('')} type="button"><X size={16}/> Clear text</button></div><p className="privacy-hint"><ShieldCheck size={15}/> Speech uses your browser’s built-in text-to-speech. It does not create or download an audio file.</p></section>
      </section>}

      {page === 'settings' && <section className="page-content"><div className="page-heading"><div className="eyebrow">PREFERENCES</div><h1>Settings & privacy</h1><p>Understand what runs on your device and manage your saved text.</p></div><section className="card settings-card"><div className="setting-row"><span className="setting-icon"><ShieldCheck/></span><div><strong>On-device transcription</strong><p>Whisper Tiny runs in your browser after its model downloads. The first run requires internet, and low-memory phones may struggle with long audio.</p></div></div><div className="setting-row"><span className="setting-icon"><BookOpen/></span><div><strong>Local transcript library</strong><p>{library.length} saved transcript(s). Text is stored in this browser’s local storage, not synced to another device. Clearing browser data can erase it.</p></div><button className="secondary small-button" onClick={() => {if (window.confirm('Delete all saved transcripts from this browser?')) setLibrary([]);}} type="button"><Trash2 size={15}/> Clear library</button></div><div className="setting-row"><span className="setting-icon"><Mic2/></span><div><strong>Voice Studio</strong><p>Uses the browser’s built-in speech synthesis. Available voices depend on Android and Chrome.</p></div></div><div className="setting-row"><span className="setting-icon"><Download/></span><div><strong>Export your work</strong><p>Export individual transcripts as TXT, Markdown, HTML or RTF, or use Print / Save as PDF. Export files are created on your device.</p></div></div></section></section>}

      {error && <div className="error-message" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error" type="button"><X size={16}/></button></div>}
      <footer className="footer"><span><AudioLines size={15}/> AURORA VoiceText</span><span><ShieldCheck size={14}/> Local-first workspace</span><span><Clock3 size={14}/> English + Nigerian Pidgin · review results</span></footer>
    </main>
  );
}

export default App;
