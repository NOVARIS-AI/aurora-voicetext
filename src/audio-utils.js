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
