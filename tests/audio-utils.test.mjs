import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimatedSubtitles, createTimedSubtitles, mergeTranscriptParts, normalizeSubtitleText, safeAudioInputName, chooseAudioSegmentSeconds } from '../src/audio-utils.js';

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
