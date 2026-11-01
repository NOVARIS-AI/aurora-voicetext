import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
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
function makeAudioFileKey(file: File): string {
  return [file.name, file.size, file.lastModified, file.type].join('|');
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
    score: sentence.split(/\s+/).length > 4 ? 1 : 0 +
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

async function transcribeOnline(audio: Float32Array, index: number, total: number): Promise<string> {
  const response = await fetch(transcriptionApiUrl, {
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

async function decodeAudio(file: File): Promise<Float32Array> {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('Audio decoding is not supported in this browser. Try Chrome.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const targetRate = 16000;
    const outputLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const OfflineContext = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (OfflineContext) {
      const offline = new OfflineContext(1, outputLength, targetRate);
      const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
      const destination = mono.getChannelData(0);
      for (let i = 0; i < decoded.length; i++) {
        let sample = 0;
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) sample += decoded.getChannelData(channel)[i] || 0;
        destination[i] = sample / decoded.numberOfChannels;
      }
      const source = offline.createBufferSource();
      source.buffer = mono;
      source.connect(offline.destination);
      source.start(0);
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0).slice();
    }
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = i * decoded.sampleRate / targetRate;
      const left = Math.min(decoded.length - 1, Math.floor(position));
      const right = Math.min(decoded.length - 1, left + 1);
      const fraction = position - left;
      let sample = 0;
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel);
        sample += data[left] * (1 - fraction) + data[right] * fraction;
      }
      output[i] = sample / decoded.numberOfChannels;
    }
    return output;
  } finally { await context.close(); }
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
  const inputName = 'aurora-offline-input.' + extension;
  const parts: string[] = [];
  const pcmToFloat = (bytes: Uint8Array): Float32Array => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let dataStart = -1;
    let dataLength = 0;
    while (offset + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') { dataStart = offset + 8; dataLength = Math.min(size, bytes.length - dataStart); break; }
      offset += 8 + size + (size % 2);
    }
    if (dataStart < 0 || dataLength < 2) throw new Error('The offline decoder produced an invalid PCM audio section.');
    const samples = Math.floor(dataLength / 2);
    const audio = new Float32Array(samples);
    for (let i = 0; i < samples; i++) audio[i] = view.getInt16(dataStart + i * 2, true) / 32768;
    return audio;
  };
  try {
    onStatus('Loading on-device audio compatibility decoder…');
    await ffmpeg.load({
      coreURL: await toBlobURL(coreBase + '/ffmpeg-core.js', 'text/javascript'),
      wasmURL: await toBlobURL(coreBase + '/ffmpeg-core.wasm', 'application/wasm'),
    });
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    await ffmpeg.exec([
      '-i', inputName, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '120',
      '-reset_timestamps', '1', '-segment_format', 'wav', 'aurora-offline-%03d.wav',
    ]);
    const entries = await ffmpeg.listDir('/');
    const total = entries.filter(entry => entry.name.startsWith('aurora-offline-') && entry.name.endsWith('.wav')).length;
    if (!total) throw new Error('The decoder could not find any audio sections.');
    const whisper = await getWhisper(onStatus);
    for (let index = 0; index < total; index++) {
      const name = 'aurora-offline-' + String(index).padStart(3, '0') + '.wav';
      const output = await ffmpeg.readFile(name);
      if (typeof output === 'string') throw new Error('The offline decoder returned invalid audio data.');
      const audio = pcmToFloat(output);
      if (audioRms(audio) < 0.0015) {
        parts.push('');
      } else {
        onStatus('On-device Whisper · section ' + (index + 1) + ' of ' + total + '…');
        const result = await whisper(audio, { sampling_rate: 16000, chunk_length_s: 30, stride_length_s: 5 });
        const text = result.text?.trim() || '';
        if (!text) throw new Error('Whisper Tiny returned no transcript for section ' + (index + 1) + '.');
        parts.push(text);
      }
      onProgress(index + 1, total);
      onPart(parts.filter(Boolean));
      try { await ffmpeg.deleteFile(name); } catch { /* Continue cleanup. */ }
    }
    if (!parts.some(Boolean)) throw new Error('No clear speech was detected in this recording.');
    return parts.filter(Boolean);
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch { /* Input may not have been created. */ }
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
  const inputName = 'aurora-input.' + extension;
  const parts: string[] = [];
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
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    await ffmpeg.exec([
      '-i', inputName, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'segment', '-segment_time', '120',
      '-reset_timestamps', '1', '-segment_format', 'mp3', 'aurora-part-%03d.mp3',
    ]);
    const entries = await ffmpeg.listDir('/');
    const totalParts = entries.filter(entry => entry.name.startsWith('aurora-part-') && entry.name.endsWith('.mp3')).length;
    for (let index = 0; index < totalParts; index++) {
      const name = 'aurora-part-' + String(index).padStart(3, '0') + '.mp3';
      let bytes: Uint8Array;
      try {
        const output = await ffmpeg.readFile(name);
        if (typeof output === 'string') throw new Error('Unexpected text audio output.');
        bytes = output;
      } catch {
        break;
      }
      const response = await fetch(transcriptionApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: toBase64(bytes),
          mimeType: 'audio/mpeg',
          chunkNumber: index + 1,
          languageHint: 'English and Nigerian Pidgin',
        }),
      });
      const result = await response.json().catch(() => ({})) as { text?: string; error?: string };
      if (!response.ok) throw new Error(result.error || 'Transcription failed on audio section ' + (index + 1) + '.');
      if (typeof result.text === 'string' && result.text.trim()) parts.push(result.text.trim());
      onProgress(index + 1, totalParts);
      onPart(parts);
      await ffmpeg.deleteFile(name);
    }
    if (!parts.length) throw new Error('The audio decoder found no transcribable speech sections.');
    return parts;
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch { /* Input may not have been created. */ }
    ffmpeg.terminate();
  }
}

function mergeTranscriptParts(parts: string[]): string {
  const merged: string[] = [];
  for (const part of parts) {
    const next = part.trim().split(/\s+/).filter(Boolean);
    if (!next.length) continue;
    if (!merged.length) { merged.push(...next); continue; }
    const current = merged.map(word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
    const incoming = next.map(word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''));
    let overlap = 0;
    const limit = Math.min(30, current.length, incoming.length);
    for (let size = limit; size >= 2; size--) {
      if (current.slice(-size).every((word, index) => word && word === incoming[index])) { overlap = size; break; }
    }
    merged.push(...next.slice(overlap));
  }
  return merged.join(' ').replace(/\s+([,.;!?])/g, '$1').trim();
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
  const checkpointRef = useRef<TranscriptionCheckpoint | null>(null);
  const [error, setError] = useState('');
  const [exportType, setExportType] = useState('txt');
  const [studioText, setStudioText] = useState('');
  const [voiceRate, setVoiceRate] = useState(1);
  const [voicePitch, setVoicePitch] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [summary, setSummary] = useState('');
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const active = files.find(item => item.id === activeId) ?? files[0] ?? null;

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(library)); } catch { /* Browser storage can be full or disabled. */ }
  }, [library]);

  useEffect(() => () => files.forEach(item => URL.revokeObjectURL(item.url)), []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const accepted = Array.from(list).filter(file => file.type.startsWith('audio/') || /\.(opus|ogg|mp3|m4a|wav|aac|amr|3gp|webm)$/i.test(file.name));
    if (!accepted.length) { setError('Choose an audio file such as OPUS, OGG, MP3, M4A or WAV.'); return; }
    const next = accepted.map(file => ({ id: crypto.randomUUID?.() ?? String(Date.now() + Math.random()), file, url: URL.createObjectURL(file), transcript: '' }));
    setFiles(current => [...current, ...next]);
    setActiveId(current => current ?? next[0].id);
    setError('');
  }


  async function transcribe() {
    if (!active || busy) return;
    setBusy(true); setError(''); setStatus('Preparing audio…');
    try {
      let audio: Float32Array;
      try {
        audio = await decodeAudio(active.file);
      } catch (decodeProblem) {
        if (mode === 'offline') {
          setStatus('Offline mode · decoding audio into local sections…');
          setProgress({ completed: 0, total: 0 });
          const parts = await transcribeOpusOfflineInSegments(
            active.file,
            (completed, total) => {
              setProgress({ completed, total });
              setStatus('On-device transcription · completed ' + completed + ' audio sections…');
            },
            currentParts => {
              const partial = mergeTranscriptParts(currentParts);
              if (partial) setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: partial } : item));
            },
            setStatus,
          );
          const completedText = mergeTranscriptParts(parts);
          if (!completedText) throw new Error('No clear speech was detected in this recording.');
          setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: completedText } : item));
          setStatus('Offline transcription complete. Audio was processed on this device.');
          setProgress({ completed: parts.length, total: parts.length });
          return;
        }
        setStatus('Using AURORA compatibility decoder · preparing audio sections…');
        setProgress({ completed: 0, total: 0 });
        const parts = await transcribeOpusInSegments(
          active.file,
          (completed, total) => {
            setProgress({ completed, total });
            setStatus('Groq transcription · completed ' + completed + ' audio sections…');
          },
          currentParts => {
            const partial = mergeTranscriptParts(currentParts);
            if (partial) setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: partial } : item));
          },
        );
        const completedText = mergeTranscriptParts(parts);
        if (!completedText) throw new Error('No clear speech was detected in this recording.');
        setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: completedText } : item));
        setStatus('Transcription complete. Review names, numbers and Nigerian Pidgin before sharing.');
        setProgress({ completed: parts.length, total: parts.length });
        return;
      }
      const sampleRate = 16000, chunkSamples = 20 * sampleRate, overlapSamples = 2 * sampleRate;
      const totalChunks = Math.ceil(audio.length / (chunkSamples - overlapSamples));
      const previous = checkpointRef.current;
      const fileKey = makeAudioFileKey(active.file);
      let restored: TranscriptionCheckpoint | null = null;
      if (!(previous?.fileId === active.id && previous.totalChunks === totalChunks)) {
        try {
          const saved = await readSavedCheckpoint(fileKey);
          if (saved && saved.totalChunks === totalChunks && saved.nextChunk > 0 && saved.nextChunk < totalChunks) restored = { ...saved, fileId: active.id };
        } catch { /* Continue with an in-session checkpoint if persistent storage is unavailable. */ }
      }
      const checkpoint = previous?.fileId === active.id && previous.totalChunks === totalChunks
        ? previous
        : restored ?? { fileId: active.id, parts: [] as string[], nextChunk: 0, totalChunks };
      checkpointRef.current = checkpoint;
      const parts = checkpoint.parts;
      setProgress({ completed: checkpoint.nextChunk, total: totalChunks });
      if (checkpoint.nextChunk > 0) setStatus('Resuming from saved section ' + (checkpoint.nextChunk + 1) + ' of ' + totalChunks + '…');
      for (let index = checkpoint.nextChunk, start = checkpoint.nextChunk * (chunkSamples - overlapSamples); start < audio.length; index++, start += chunkSamples - overlapSamples) {
        const chunk = audio.slice(start, Math.min(audio.length, start + chunkSamples));
        if (audioRms(chunk) < 0.0015) {
          setStatus('Skipping quiet section ' + (index + 1) + ' of ' + totalChunks + '…');
          checkpoint.nextChunk = index + 1;
          try { await writeSavedCheckpoint(fileKey, checkpoint); } catch { /* In-session resume remains available. */ }
          setProgress({ completed: index + 1, total: totalChunks });
          continue;
        }
        let part = '';
        const runOffline = async (): Promise<string> => {
          let whisperProblem = '';
          try {
            setStatus('Offline backup · Whisper Tiny · section ' + (index + 1) + ' of ' + totalChunks + '…');
            const whisper = await getWhisper(setStatus);
            const result = await whisper(chunk, { sampling_rate: sampleRate });
            const text = result.text?.trim() || '';
            if (!text) throw new Error('Whisper Tiny returned an empty result.');
            return text;
          } catch (reason) {
            whisperProblem = reason instanceof Error ? reason.message : String(reason);
          }
          try {
            setStatus('Whisper Tiny unavailable. Trying the Vosk offline backup…');
            return await transcribeWithVosk(chunk);
          } catch (voskProblem) {
            throw new Error('Offline backup unavailable. Whisper: ' + whisperProblem + ' Vosk: ' + (voskProblem instanceof Error ? voskProblem.message : String(voskProblem)));
          }
        };

        if (mode === 'online') {
          setStatus('Groq Whisper · section ' + (index + 1) + ' of ' + totalChunks + '…');
          part = await transcribeOnline(chunk, index, totalChunks);
        } else if (mode === 'offline') {
          part = await runOffline();
        } else {
          try {
            setStatus('Auto · using Groq Whisper for the clearest transcript · section ' + (index + 1) + ' of ' + totalChunks + '…');
            part = await transcribeOnline(chunk, index, totalChunks);
          } catch (onlineProblem) {
            setStatus('Online service unavailable. Switching to on-device transcription…');
            try {
              part = await runOffline();
            } catch (offlineProblem) {
              throw new Error('Automatic transcription could not complete. Online: ' + (onlineProblem instanceof Error ? onlineProblem.message : String(onlineProblem)) + ' · Offline: ' + (offlineProblem instanceof Error ? offlineProblem.message : String(offlineProblem)));
            }
          }
        }
        if (part.trim()) parts.push(part.trim());
        checkpoint.nextChunk = index + 1;
        try { await writeSavedCheckpoint(fileKey, checkpoint); } catch { /* In-session resume remains available. */ }
        setProgress({ completed: index + 1, total: totalChunks });
        const partialText = mergeTranscriptParts(parts);
        if (partialText) setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: partialText } : item));
        setStatus('Completed section ' + (index + 1) + ' of ' + totalChunks + '. Progress is saved for this session.');
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      const text = mergeTranscriptParts(parts);
      if (!text) throw new Error('No clear speech was detected. Try a louder recording with less background noise, or check that the audio contains speech.');
      setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: text } : item));
      checkpointRef.current = null;
      try { await removeSavedCheckpoint(fileKey); } catch { /* A stale completed checkpoint is ignored on the next run. */ }
      setProgress({ completed: totalChunks, total: totalChunks });
      setStatus('Transcription complete. Check names and Nigerian Pidgin before sharing.');
    } catch (reason) {
      const saved = checkpointRef.current;
      if (saved?.fileId === active.id && saved.parts.length) {
        const partialText = mergeTranscriptParts(saved.parts);
        setFiles(current => current.map(item => item.id === active.id ? { ...item, transcript: partialText } : item));
        setError('A section failed. ' + saved.nextChunk + ' of ' + saved.totalChunks + ' sections are complete; tap Transcribe again to resume. ' + (reason instanceof Error ? reason.message : String(reason)));
        setStatus('Partial transcript preserved. If browser storage is available, progress can also survive a refresh after you reselect the same audio file.');
      } else {
        setError(reason instanceof Error ? reason.message : 'Transcription failed.');
        setStatus('');
      }
    } finally { setBusy(false); }
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
    };
    const selected = extensions[exportType] ?? extensions.txt;
    downloadFile(baseName + '.' + selected.ext, selected.text, selected.mime);
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
            <input ref={inputRef} className="hidden-input" type="file" accept="audio/*,.opus,.ogg,.mp3,.m4a,.wav,.aac,.amr,.3gp,.webm" multiple onChange={event => addFiles(event.target.files)}/>
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
              {progress.total > 0 && <div className="progress-wrap" aria-label={'Transcription progress: ' + progress.completed + ' of ' + progress.total + ' sections'}><div className="progress-meta"><span>Section progress</span><strong>{Math.round((progress.completed / progress.total) * 100)}%</strong></div><div className="progress-track"><span style={{ width: (progress.completed / progress.total) * 100 + '%' }} /></div><small>{progress.completed} of {progress.total} sections completed · unfinished sections can resume while this page stays open</small></div>}
              <label className="field-label" htmlFor="transcript">Transcript text</label>
              <textarea id="transcript" className="transcript-input" value={active.transcript} onChange={event => updateTranscript(event.target.value)} placeholder="Your words will appear here. Review names, numbers and Pidgin, then edit anything AURORA missed."/>
              <div className="editor-tools"><span>{active.transcript.trim() ? active.transcript.trim().split(/\s+/).length : 0} words</span><button className="secondary small-button" type="button" onClick={saveToLibrary}><Save size={15}/> Save to library</button></div>
              <div className="summary-box"><div className="summary-head"><Sparkles size={16}/><strong>Quick key points</strong><button type="button" className="text-button" onClick={() => setSummary(makeSummary(active.transcript))}>Create summary</button></div><p>{summary || 'Create a short extractive summary from the current transcript. Review it before sharing.'}</p></div>
              <div className="export-row"><label className="field-label" htmlFor="export-type">Export format<select id="export-type" value={exportType} onChange={event => setExportType(event.target.value)}><option value="txt">Text (.txt)</option><option value="md">Markdown (.md)</option><option value="html">HTML (.html)</option><option value="rtf">Rich text (.rtf)</option><option value="pdf">Print / Save as PDF</option></select></label><button className="secondary" type="button" onClick={() => exportTranscript(active.transcript, active.file.name.replace(/\.[^.]+$/, '') || 'transcript')}><Download size={16}/> Export</button><button className="secondary" type="button" onClick={() => copyText(active.transcript)}><Copy size={16}/> Copy</button></div>
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
