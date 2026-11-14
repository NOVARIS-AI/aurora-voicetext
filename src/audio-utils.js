/** Returns a speech-model prompt that favours Nigerian speech without translating or standardising it. */
export function getTranscriptionLanguageHint(profile = 'nigerian-english-pidgin') {
  const hints = {
    'nigerian-english-pidgin': 'Nigerian English and Nigerian Pidgin may be mixed. Preserve Pidgin grammar, local expressions, names, places and code-switching exactly as spoken. Do not convert Pidgin into Standard English or translate.',
    'nigerian-english': 'Nigerian English. Preserve Nigerian names, places, local expressions and pronunciation-based wording; do not rewrite the speaker into another dialect.',
    'nigerian-pidgin': 'Nigerian Pidgin. Preserve Pidgin vocabulary, grammar, particles and code-switching exactly as spoken. Do not translate into Standard English.',
    yoruba: 'Yoruba as spoken in Nigeria. Preserve Yoruba words and names; do not translate.',
    igbo: 'Igbo as spoken in Nigeria. Preserve Igbo words and names; do not translate.',
    hausa: 'Hausa as spoken in Nigeria. Preserve Hausa words and names; do not translate.',
    auto: '',
  };
  return hints[profile] ?? hints.auto;
}

export function mergeTranscriptParts(parts) {
  const merged = [];
  for (const part of parts) {
    const next = String(part || '').trim().split(/\s+/).filter(Boolean);
    if (!next.length) continue;
    if (!merged.length) { merged.push(...next); continue; }
    const normalize = word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
    const current = merged.map(normalize);
    const incoming = next.map(normalize);
    let overlap = 0;
    const limit = Math.min(30, current.length, incoming.length);
    for (let size = limit; size >= 2; size--) {
      if (current.slice(-size).every((word, index) => word && word === incoming[index])) {
        overlap = size;
        break;
      }
    }
    merged.push(...next.slice(overlap));
  }
  return merged.join(' ').replace(/\s+([,.;!?])/g, '$1').trim();
}

function formatTimestamp(seconds, separator) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safe * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return String(hours).padStart(2, '0') + ':' +
    String(minutes).padStart(2, '0') + ':' +
    String(secs).padStart(2, '0') + separator +
    String(millis).padStart(3, '0');
}

/**
 * Creates estimated subtitle cues. These are not forced-alignment
 * timestamps; actual word timing requires a speech-alignment engine.
 */
export function createEstimatedSubtitles(text, format = 'srt') {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return format === 'vtt' ? 'WEBVTT\n' : '';
  const cues = [];
  const wordsPerCue = 9;
  let cursor = 0;
  for (let offset = 0; offset < words.length; offset += wordsPerCue) {
    const group = words.slice(offset, offset + wordsPerCue);
    const start = cursor;
    const duration = Math.max(1.6, group.length / 2.5);
    const end = start + duration;
    cues.push({ start, end, text: group.join(' ') });
    cursor = end + 0.12;
  }
  const vtt = format === 'vtt';
  const blocks = cues.map((cue, index) =>
    (vtt ? '' : String(index + 1) + '\n') +
    formatTimestamp(cue.start, vtt ? '.' : ',') + ' --> ' +
    formatTimestamp(cue.end, vtt ? '.' : ',') + '\n' + cue.text
  );
  return (vtt ? 'WEBVTT\n\n' : '') + blocks.join('\n\n') + '\n';
}


/** Builds SRT/WebVTT cues from real speech-segment timestamps returned by Whisper. */
export function createTimedSubtitles(segments, format = 'srt') {
  const valid = (Array.isArray(segments) ? segments : []).filter(item =>
    Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && String(item.text || '').trim()
  );
  const vtt = format === 'vtt';
  if (!valid.length) return vtt ? 'WEBVTT\n' : '';
  const blocks = valid.map((item, index) =>
    (vtt ? '' : String(index + 1) + '\n') +
    formatTimestamp(item.start, vtt ? '.' : ',') + ' --> ' +
    formatTimestamp(item.end, vtt ? '.' : ',') + '\n' + String(item.text).trim()
  );
  return (vtt ? 'WEBVTT\n\n' : '') + blocks.join('\n\n') + '\n';
}


/** Normalize subtitle documents and line endings for SRT/WebVTT exports. */
export function normalizeSubtitleText(value, format = 'srt') {
  const normalized = String(value || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const lines = normalized ? normalized.split('\n') : [];
  if (format === 'vtt') {
    const header = lines.length && /^WEBVTT(?:\s|$)/i.test(lines[0]) ? lines.shift() : 'WEBVTT';
    const converted = lines.map(line =>
      /^\s*\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(line)
        ? line.replace(/,(\d{3})/g, '.$1')
        : line
    );
    return [header, '', ...converted].join('\n').trimEnd() + '\n';
  }
  if (lines.length && /^WEBVTT(?:\s|$)/i.test(lines[0])) lines.shift();
  const output = lines.map(line => line.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')).join('\n').trim();
  return output ? output + '\n' : '';
}


/** Return a stable FFmpeg virtual-filesystem name for arbitrary user filenames. */
export function safeAudioInputName(value) {
  const original = String(value || 'audio').split(/[\\/]/).pop() || 'audio';
  const extension = (original.match(/\.([a-z0-9]{1,8})$/i)?.[1] || 'audio').toLowerCase();
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'audio';
  return 'source-audio.' + safeExtension;
}

/**
 * Pick a conservative per-section duration. Android WebView deviceMemory is
 * often missing, so native builds deliberately use smaller sections.
 */
export function chooseAudioSegmentSeconds({ native = false, memory, cores = 2, mode = 'online' } = {}) {
  const ceiling = mode === 'offline' ? 60 : 90;
  if (native) return 35;
  if (typeof memory === 'number' && memory <= 2) return 30;
  if (typeof memory === 'number' && memory <= 4) return 45;
  if (cores <= 4) return 45;
  return ceiling;
}

/** Stop between audio sections without discarding completed checkpoints. */
export function throwIfTranscriptionAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Transcription cancelled. Completed sections are saved; select the same recording and retry to resume.');
  error.name = 'AbortError';
  throw error;
}


/** Build a stable Android checkpoint identity from the imported audio content. */
export function createNativeAudioResumeKey({ name, size, mimeType, contentHash } = {}) {
  const safeName = String(name || '').trim();
  const byteSize = Number(size);
  const hash = String(contentHash || '').toLowerCase();
  if (!safeName || !Number.isSafeInteger(byteSize) || byteSize <= 0 || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Android audio identity is incomplete; re-import the recording before resuming.');
  }
  return ['native-audio-v1', safeName, byteSize, String(mimeType || 'application/octet-stream'), hash].join('|');
}

/**
 * Validate a persisted section checkpoint before reusing it. A checkpoint is
 * accepted only for the exact recording identity and processing configuration
 * that created it; malformed timing data is discarded rather than merged.
 */
export function isValidTranscriptionCheckpoint(value, expected = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value;
  const { fileId, totalChunks, mode, segmentSeconds, overlapSeconds } = expected;
  if (typeof fileId !== 'string' || !fileId || checkpoint.fileId !== fileId) return false;
  if (!['online', 'offline'].includes(mode) || checkpoint.mode !== mode) return false;
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || checkpoint.totalChunks !== totalChunks) return false;
  if (!Number.isFinite(segmentSeconds) || segmentSeconds < 15 || checkpoint.segmentSeconds !== segmentSeconds) return false;
  if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0 || checkpoint.overlapSeconds !== overlapSeconds) return false;
  if (!Number.isInteger(checkpoint.nextChunk) || checkpoint.nextChunk < 0 || checkpoint.nextChunk > totalChunks) return false;
  if (!Array.isArray(checkpoint.parts) || checkpoint.parts.length !== checkpoint.nextChunk) return false;
  if (!checkpoint.parts.every(part => typeof part === 'string')) return false;
  if (checkpoint.segments !== undefined) {
    if (!Array.isArray(checkpoint.segments)) return false;
    if (!checkpoint.segments.every(segment =>
      segment && typeof segment === 'object' &&
      Number.isFinite(segment.start) && segment.start >= 0 &&
      Number.isFinite(segment.end) && segment.end > segment.start &&
      typeof segment.text === 'string' && segment.text.trim().length > 0 &&
      (segment.speaker === undefined || typeof segment.speaker === 'string')
    )) return false;
  }
  return true;
}

/** Identify video containers that can be passed to FFmpeg for audio-track extraction. */
export function isVideoMediaFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '');
  return type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name);
}


/** Identify AMR-NB/WB recordings by extension or common Android MIME types. */
export function isAmrMediaFile(file) {
  const name = String(file?.name || '');
  const type = String(file?.type || '').toLowerCase();
  return /\\.amr$/i.test(name) || type === 'audio/amr' || type === 'audio/3gpp';
}

/** Read AMR frame headers to estimate duration without browser codec support. */
export function getAmrDurationSeconds(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const startsWith = signature => {
    if (bytes.length < signature.length) return false;
    for (let i = 0; i < signature.length; i++) {
      if (bytes[i] !== signature.charCodeAt(i)) return false;
    }
    return true;
  };
  const wideband = startsWith('#!AMR-WB\\n');
  const narrowband = !wideband && startsWith('#!AMR\\n');
  if (!wideband && !narrowband) return null;
  const headerLength = wideband ? 9 : 6;
  const frameSizes = wideband
    ? [18, 24, 33, 37, 41, 47, 51, 59, 61, 6]
    : [13, 14, 16, 18, 20, 21, 27, 32, 6];
  let offset = headerLength;
  let frames = 0;
  while (offset < bytes.length) {
    const frameType = (bytes[offset] >> 3) & 0x0f;
    let frameSize = frameSizes[frameType];
    if (frameType === 15 || (wideband && frameType === 14)) frameSize = 1;
    if (!frameSize || offset + frameSize > bytes.length) return null;
    offset += frameSize;
    frames++;
  }
  return frames > 0 ? frames * 0.02 : null;
}

/** Safely estimate the duration of a selected AMR recording. */
export async function getAmrFileDurationSeconds(file) {
  if (!isAmrMediaFile(file)) return null;
  try {
    return getAmrDurationSeconds(new Uint8Array(await file.arrayBuffer()));
  } catch {
    return null;
  }
}

