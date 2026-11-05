import test from 'node:test';
import assert from 'node:assert/strict';
import { clampAudioEditPlan, formatAudioTime, encodeAudioBufferWav } from '../src/audio-editor.js';

test('clamps trim, gain, speed and fades to safe bounds', () => {
  const plan = clampAudioEditPlan({ duration: 100, start: -5, end: 200, speed: 9, volume: 4, fadeIn: 90, fadeOut: -1 });
  assert.equal(plan.start, 0);
  assert.equal(plan.end, 100);
  assert.equal(plan.speed, 2);
  assert.equal(plan.volume, 2);
  assert.equal(plan.fadeIn, 50);
  assert.equal(plan.fadeOut, 0);
  assert.equal(plan.outputDuration, 50);
});

test('marks empty and tiny selections as invalid', () => {
  assert.equal(clampAudioEditPlan({ duration: 10, start: 5, end: 5, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 }).valid, false);
});

test('formats short and long audio time consistently', () => {
  assert.equal(formatAudioTime(65), '01:05');
  assert.equal(formatAudioTime(3661), '01:01:01');
});

test('encodes mono and stereo audio buffers as PCM16 WAV', () => {
  const fakeBuffer = {
    numberOfChannels: 2, length: 2, sampleRate: 8000,
    getChannelData(channel) { return channel === 0 ? new Float32Array([-1, 0.5]) : new Float32Array([1, -0.5]); },
  };
  const wav = encodeAudioBufferWav(fakeBuffer);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 52);
  assert.equal(String.fromCharCode(...new Uint8Array(wav.slice(0, 4))), 'RIFF');
  assert.equal(String.fromCharCode(...new Uint8Array(wav.slice(8, 12))), 'WAVE');
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 32767);
});
