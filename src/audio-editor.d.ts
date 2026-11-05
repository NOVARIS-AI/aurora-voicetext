export type AudioEditPlan = {
  start: number; end: number; speed: number; volume: number;
  fadeIn: number; fadeOut: number; selectedDuration: number;
  outputDuration: number; valid: boolean;
};
export function clampAudioEditPlan(input: {
  duration: number; start: number; end: number; speed: number;
  volume: number; fadeIn: number; fadeOut: number;
}): AudioEditPlan;
export function formatAudioTime(seconds: number): string;
export function encodeAudioBufferWav(buffer: AudioBuffer): ArrayBuffer;
