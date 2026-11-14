import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimatedSubtitles, createTimedSubtitles, mergeTranscriptParts, normalizeSubtitleText, safeAudioInputName, chooseAudioSegmentSeconds, isVideoMediaFile, isAmrMediaFile, getAmrDurationSeconds, getAmrFileDurationSeconds } from '../src/audio-utils.js';

test('merges duplicate words at section boundaries', () => {
  assert.equal(
    mergeTranscriptParts(['We are building a reliable audio app', 'a reliable audio app for everyone']),
    'We are building a reliable audio app for everyone',
  );
});

test('ignores empty sections and normalizes punctuation spacing', () => {
  assert.equal(mergeTranscriptParts(['Hello there ,', '', 'how are you ?']), 'Hello there, how are you?');
});

test('creates valid estimated SRT cue blocks with increasing times', () => {
  const output = createEstimatedSubtitles('one two three four five six seven eight nine ten eleven', 'srt');
  assert.match(output, /^1\n00:00:00,000 --> 00:00:03,600/);
  assert.match(output, /2\n00:00:03,720 -->/);
});

test('creates WebVTT with required header and dot milliseconds', () => {
  const output = createEstimatedSubtitles('A short test transcript.', 'vtt');
  assert.match(output, /^WEBVTT\n\n/);
  assert.match(output, /00:00:00\.000 --> 00:00:01\.600/);
});

test('returns an empty subtitle document safely', () => {
  assert.equal(createEstimatedSubtitles('', 'srt'), '');
  assert.equal(createEstimatedSubtitles('', 'vtt'), 'WEBVTT\n');
});


test('exports actual speech timestamps as SRT and WebVTT', () => {
  const segments = [{ start: 12.4, end: 14.1, text: 'Hello there.' }];
  assert.match(createTimedSubtitles(segments, 'srt'), /00:00:12,400 --> 00:00:14,100/);
  assert.match(createTimedSubtitles(segments, 'vtt'), /00:00:12\.400 --> 00:00:14\.100/);
});

test('merges overlapping section text without dropping non-overlapping words', () => {
  assert.equal(
    mergeTranscriptParts(['The quick brown fox jumps over', 'jumps over the lazy dog']),
    'The quick brown fox jumps over the lazy dog',
  );
});

test('keeps non-overlapping repeated words from separate sections', () => {
  assert.equal(
    mergeTranscriptParts(['yes we can', 'we can do it']),
    'yes we can do it',
  );
});

test('filters invalid and empty timed subtitle segments', () => {
  const output = createTimedSubtitles([
    { start: 4, end: 3, text: 'invalid reversed time' },
    { start: 1, end: 2, text: '   ' },
    { start: 2.25, end: 3.5, text: 'Valid segment' },
  ], 'srt');
  assert.match(output, /^1\n00:00:02,250 --> 00:00:03,500\nValid segment\n$/);
  assert.doesNotMatch(output, /invalid reversed time/);
});

test('keeps an empty timed WebVTT file valid', () => {
  assert.equal(createTimedSubtitles([], 'vtt'), 'WEBVTT\n');
});



test('normalizes WebVTT timestamps and CRLF into valid SRT', () => {
  const source = 'WEBVTT\r\n\r\n00:00:01.250 --> 00:00:02.500\r\nHello\r\n';
  assert.equal(normalizeSubtitleText(source, 'srt'), '00:00:01,250 --> 00:00:02,500\nHello\n');
});

test('normalizes SRT timestamps and adds the WebVTT header', () => {
  const source = '1\n00:00:01,250 --> 00:00:02,500\nHello';
  assert.equal(normalizeSubtitleText(source, 'vtt'), 'WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\nHello\n');
});

test('handles empty subtitle input and strips a Unicode BOM', () => {
  assert.equal(normalizeSubtitleText('', 'srt'), '');
  assert.equal(normalizeSubtitleText('\uFEFFWEBVTT\n', 'vtt'), 'WEBVTT\n');
});


test('creates safe FFmpeg input names from user-selected filenames', () => {
  assert.equal(safeAudioInputName('meeting recording.opus'), 'source-audio.opus');
  assert.equal(safeAudioInputName('../../folder\\\\voice note.M4A'), 'source-audio.m4a');
  assert.equal(safeAudioInputName('no-extension'), 'source-audio.audio');
});

test('chooses conservative audio sections for low-memory and Android devices', () => {
  assert.equal(chooseAudioSegmentSeconds({ native: true, memory: 8, cores: 8 }), 35);
  assert.equal(chooseAudioSegmentSeconds({ memory: 2, cores: 8 }), 30);
  assert.equal(chooseAudioSegmentSeconds({ memory: 4, cores: 8 }), 45);
  assert.equal(chooseAudioSegmentSeconds({ memory: 8, cores: 4 }), 45);
  assert.equal(chooseAudioSegmentSeconds({ memory: 8, cores: 8, mode: 'offline' }), 60);
  assert.equal(chooseAudioSegmentSeconds({ memory: 8, cores: 8, mode: 'online' }), 90);
});


test('cancels only at a safe section boundary with a resumable message', async () => {
  const { throwIfTranscriptionAborted } = await import('../src/audio-utils.js');
  assert.doesNotThrow(() => throwIfTranscriptionAborted({ aborted: false }));
  assert.throws(
    () => throwIfTranscriptionAborted({ aborted: true }),
    error => error.name === 'AbortError' && /completed sections are saved/i.test(error.message),
  );
});


test('creates stable native resume keys across Android re-import paths', async () => {
  const { createNativeAudioResumeKey } = await import('../src/audio-utils.js');
  const first = createNativeAudioResumeKey({ name: 'meeting.opus', size: 123456, mimeType: 'audio/ogg', contentHash: 'a'.repeat(64) });
  const second = createNativeAudioResumeKey({ name: 'meeting.opus', size: 123456, mimeType: 'audio/ogg', contentHash: 'a'.repeat(64) });
  assert.equal(first, second);
  assert.notEqual(first, createNativeAudioResumeKey({ name: 'meeting.opus', size: 123456, mimeType: 'audio/ogg', contentHash: 'b'.repeat(64) }));
});

test('rejects incomplete native audio identities rather than creating unsafe resume keys', async () => {
  const { createNativeAudioResumeKey } = await import('../src/audio-utils.js');
  assert.throws(() => createNativeAudioResumeKey({ name: 'meeting.opus', size: 0, contentHash: 'a'.repeat(64) }), /identity is incomplete/i);
  assert.throws(() => createNativeAudioResumeKey({ name: 'meeting.opus', size: 123, contentHash: 'not-a-hash' }), /identity is incomplete/i);
});


test('accepts a checkpoint only for the matching recording and processing settings', async () => {
  const { isValidTranscriptionCheckpoint } = await import('../src/audio-utils.js');
  const checkpoint = {
    fileId: 'recording-a', mode: 'online', segmentSeconds: 45, overlapSeconds: 2,
    totalChunks: 3, nextChunk: 1, parts: ['First section'],
    segments: [{ start: 0, end: 4.2, text: 'First section' }],
  };
  const expected = { fileId: 'recording-a', mode: 'online', segmentSeconds: 45, overlapSeconds: 2, totalChunks: 3 };
  assert.equal(isValidTranscriptionCheckpoint(checkpoint, expected), true);
  assert.equal(isValidTranscriptionCheckpoint(checkpoint, { ...expected, fileId: 'another-recording' }), false);
  assert.equal(isValidTranscriptionCheckpoint(checkpoint, { ...expected, mode: 'offline' }), false);
  assert.equal(isValidTranscriptionCheckpoint(checkpoint, { ...expected, segmentSeconds: 60 }), false);
});

test('rejects damaged checkpoint parts and invalid timestamp segments', async () => {
  const { isValidTranscriptionCheckpoint } = await import('../src/audio-utils.js');
  const base = {
    fileId: 'recording-a', mode: 'offline', segmentSeconds: 35, overlapSeconds: 2,
    totalChunks: 2, nextChunk: 1, parts: ['Saved section'],
    segments: [{ start: 0, end: 3, text: 'Saved section' }],
  };
  const expected = { fileId: 'recording-a', mode: 'offline', segmentSeconds: 35, overlapSeconds: 2, totalChunks: 2 };
  assert.equal(isValidTranscriptionCheckpoint({ ...base, parts: [] }, expected), false);
  assert.equal(isValidTranscriptionCheckpoint({ ...base, segments: [{ start: 4, end: 2, text: 'Bad timing' }] }, expected), false);
  assert.equal(isValidTranscriptionCheckpoint({ ...base, segments: [{ start: 0, end: 1, text: ' ' }] }, expected), false);
  assert.equal(isValidTranscriptionCheckpoint({ ...base, nextChunk: 3 }, expected), false);
});


test('recognizes supported video containers by MIME type or filename', () => {
  for (const name of ['clip.mp4', 'clip.MOV', 'clip.mkv', 'clip.webm', 'clip.avi', 'clip.m4v']) {
    assert.equal(isVideoMediaFile({ name, type: '' }), true, name);
  }
  assert.equal(isVideoMediaFile({ name: 'clip.bin', type: 'video/mp4' }), true);
  assert.equal(isVideoMediaFile({ name: 'voice.mp3', type: 'audio/mpeg' }), false);
  assert.equal(isVideoMediaFile({ name: 'document.pdf', type: 'application/pdf' }), false);
});


test('provides Nigerian English and Pidgin transcription guidance without translating', async () => {
  const { getTranscriptionLanguageHint } = await import('../src/audio-utils.js');
  const mixed = getTranscriptionLanguageHint('nigerian-english-pidgin');
  assert.match(mixed, /Nigerian English and Nigerian Pidgin/);
  assert.match(mixed, /Do not convert Pidgin into Standard English/);
  assert.equal(getTranscriptionLanguageHint('auto'), '');
  assert.match(getTranscriptionLanguageHint('yoruba'), /Yoruba as spoken in Nigeria/);
});


test('recognizes AMR recordings from extensions and Android MIME types', () => {
  assert.equal(isAmrMediaFile({ name: 'voice.AMR', type: '' }), true);
  assert.equal(isAmrMediaFile({ name: 'voice.bin', type: 'audio/amr' }), true);
  assert.equal(isAmrMediaFile({ name: 'voice.3gp', type: 'audio/3gpp' }), true);
  assert.equal(isAmrMediaFile({ name: 'voice.mp3', type: 'audio/mpeg' }), false);
});

test('estimates AMR-NB duration from complete 20ms frames', () => {
  const bytes = new Uint8Array(6 + 13 * 2);
  bytes.set(new TextEncoder().encode('#!AMR\\n'));
  bytes[6] = 0; // Frame type 0, one 13-byte AMR-NB frame.
  bytes[19] = 0;
  assert.equal(getAmrDurationSeconds(bytes), 0.04);
});

test('estimates AMR-WB duration and rejects truncated or unknown data', () => {
  const bytes = new Uint8Array(9 + 18);
  bytes.set(new TextEncoder().encode('#!AMR-WB\\n'));
  bytes[9] = 0;
  assert.equal(getAmrDurationSeconds(bytes), 0.02);
  assert.equal(getAmrDurationSeconds(bytes.slice(0, 12)), null);
  assert.equal(getAmrDurationSeconds(new Uint8Array([1, 2, 3])), null);
});

test('reads AMR duration safely from a File-like object', async () => {
  const bytes = new Uint8Array(6 + 13);
  bytes.set(new TextEncoder().encode('#!AMR\\n'));
  bytes[6] = 0;
  const file = { name: 'recording.amr', type: 'audio/amr', arrayBuffer: async () => bytes.buffer };
  assert.equal(await getAmrFileDurationSeconds(file), 0.02);
  assert.equal(await getAmrFileDurationSeconds({ name: 'recording.mp3', type: 'audio/mpeg' }), null);
});
