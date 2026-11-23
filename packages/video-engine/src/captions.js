import {EngineContractError, normalizeTranscript, validateCaptionTrack, validateTimelineShape} from './contracts.js';

export const frameToMilliseconds = (frame, fps) => Math.round(frame * 1000 / fps);

export function captionTrackFromTimeline({timeline, language = 'en'}) {
  validateTimelineShape(timeline);
  if (language !== 'en') throw new EngineContractError('FEATURE_UNAVAILABLE', 'Only tested English narration/captions are enabled.');
  const track = {schemaVersion: 1, format: 'WEBVTT', mimeType: 'text/vtt', language, cues: timeline.scenes.flatMap((scene) => scene.captionSegments.map((cue) => ({...cue})))};
  validateCaptionTrack(track);
  let sceneCursor = 0;
  for (const scene of timeline.scenes) {
    const audioStart = scene.startFrame + scene.audioOffsetInFrames;
    const audioEnd = audioStart + Math.ceil(scene.measuredAudioDurationMs * timeline.fps / 1000);
    if (scene.startFrame !== sceneCursor || audioEnd > scene.startFrame + scene.durationInFrames || scene.captionSegments.some((cue) => cue.startFrame < audioStart || cue.endFrame > audioEnd)) {
      throw new EngineContractError('INVALID_CAPTIONS', 'Captions must stay inside contiguous measured scene/audio windows.');
    }
    sceneCursor += scene.durationInFrames;
  }
  if (sceneCursor !== timeline.durationInFrames) throw new EngineContractError('INVALID_CAPTIONS', 'Caption timeline total differs from its last scene end.');
  let previousEnd = 0;
  for (const cue of track.cues) {
    if (cue.startFrame < previousEnd || cue.endFrame <= cue.startFrame || cue.endFrame > timeline.durationInFrames) throw new EngineContractError('INVALID_CAPTIONS', 'Captions must have ordered non-overlapping frame boundaries.');
    previousEnd = cue.endFrame;
  }
  return track;
}

function timestamp(milliseconds) {
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

const escapeText = (text) => normalizeTranscript(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const unescapeText = (text) => text.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');

export function serializeWebVtt({timeline, language = 'en'}) {
  const track = captionTrackFromTimeline({timeline, language});
  const blocks = track.cues.map((cue, index) => `${index + 1}\n${timestamp(frameToMilliseconds(cue.startFrame, timeline.fps))} --> ${timestamp(frameToMilliseconds(cue.endFrame, timeline.fps))}\n${escapeText(cue.text)}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

export function parseWebVtt(text) {
  if (typeof text !== 'string') throw new EngineContractError('INVALID_CAPTIONS', 'Caption text must be UTF-8 WebVTT.');
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const blocks = normalized.trimEnd().split(/\n\n/gu);
  if (blocks.shift() !== 'WEBVTT') throw new EngineContractError('INVALID_CAPTIONS', 'Unsupported WebVTT header.');
  const toMs = (hours, minutes, seconds, milliseconds) => Number(hours) * 3600000 + Number(minutes) * 60000 + Number(seconds) * 1000 + Number(milliseconds);
  return blocks.map((block, index) => {
    const lines = block.split('\n');
    if (lines[0] !== String(index + 1)) throw new EngineContractError('INVALID_CAPTIONS', 'Cue identifiers must be sequential.');
    const match = lines[1]?.match(/^(\d{2}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d)\.(\d{3})$/u);
    if (!match || lines.length !== 3 || !lines[2] || /[<>]/u.test(lines[2])) throw new EngineContractError('INVALID_CAPTIONS', 'Malformed or unsafe WebVTT cue.');
    const startMs = toMs(...match.slice(1, 5));
    const endMs = toMs(...match.slice(5, 9));
    if (endMs <= startMs) throw new EngineContractError('INVALID_CAPTIONS', 'Caption cue must have positive duration.');
    return {startMs, endMs, text: unescapeText(lines[2])};
  });
}

/** Compare the written sidecar with the exact canonical frame-derived text. */
export function validateWebVtt({timeline, text, language = 'en'}) {
  const expected = serializeWebVtt({timeline, language});
  if (typeof text !== 'string' || text.replace(/\r\n/gu, '\n') !== expected) throw new EngineContractError('INVALID_CAPTIONS', 'Caption sidecar differs from the canonical measured timeline.');
  const cues = parseWebVtt(text);
  return {valid: true, format: 'WEBVTT', mimeType: 'text/vtt', language, cueCount: cues.length, cues};
}
