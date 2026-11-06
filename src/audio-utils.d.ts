export function mergeTranscriptParts(parts: string[]): string;
export function createEstimatedSubtitles(text: string, format?: 'srt' | 'vtt'): string;
export function createTimedSubtitles(segments: Array<{ start: number; end: number; text: string }>, format?: 'srt' | 'vtt'): string;
export function normalizeSubtitleText(value: string, format?: 'srt' | 'vtt'): string;
export function safeAudioInputName(value: string): string;
export function chooseAudioSegmentSeconds(options?: { native?: boolean; memory?: number; cores?: number; mode?: 'online' | 'offline' }): number;
export function throwIfTranscriptionAborted(signal?: { aborted: boolean }): void;
export function createNativeAudioResumeKey(input: { name: string; size: number; mimeType?: string; contentHash?: string }): string;
export function isValidTranscriptionCheckpoint(value: unknown, expected: { fileId: string; totalChunks: number; mode: 'online' | 'offline'; segmentSeconds: number; overlapSeconds: number }): boolean;
