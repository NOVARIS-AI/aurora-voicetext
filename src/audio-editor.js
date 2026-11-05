export function clampAudioEditPlan(input) {
  const duration = Math.max(0, Number(input.duration) || 0);
  const start = Math.min(duration, Math.max(0, Number(input.start) || 0));
  const end = Math.min(duration, Math.max(start, Number(input.end) || duration));
  const speed = Math.min(2, Math.max(0.5, Number(input.speed) || 1));
  const volume = Math.min(2, Math.max(0, Number(input.volume) || 0));
  const selectedDuration = end - start;
  const fadeIn = Math.min(selectedDuration / 2, Math.max(0, Number(input.fadeIn) || 0));
  const fadeOut = Math.min(selectedDuration / 2, Math.max(0, Number(input.fadeOut) || 0));
  return {
    start, end, speed, volume, fadeIn, fadeOut,
    selectedDuration,
    outputDuration: selectedDuration / speed,
    valid: selectedDuration >= 0.1,
  };
}

export function formatAudioTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return (hours ? String(hours).padStart(2, '0') + ':' : '') +
    String(minutes).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
}

/** Encode a rendered AudioBuffer as a standard interleaved 16-bit PCM WAV file. */
export function encodeAudioBufferWav(buffer) {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  const writeText = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return output;
}
