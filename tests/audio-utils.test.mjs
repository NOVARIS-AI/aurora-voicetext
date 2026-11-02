import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimatedSubtitles, mergeTranscriptParts } from '../src/audio-utils.js';

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
