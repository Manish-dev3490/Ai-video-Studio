import {EngineContractError, normalizeTranscript, validateStoryboard, validateTimeline, TARGET_TOLERANCE_SECONDS} from './contracts.js';

// Small, transparent pacing adjustments only. This never lengthens speech.
export const MAX_TARGET_PADDING_SECONDS = 2;
export const MAX_EXTRA_PAUSE_PER_SCENE_SECONDS = 0.5;

function invalidAudio(message) {
  throw new EngineContractError('INVALID_AUDIO_METADATA', message);
}

function measuredSegments(scene, audio) {
  const durationMs = audio.durationMs;
  if (audio.segments !== undefined && !Array.isArray(audio.segments)) invalidAudio('Narration segments must be an array of measured chunks.');
  const segments = audio.segments?.length ? audio.segments : [{text: scene.narration, startMs: 0, endMs: durationMs}];
  if (segments.length > 100) invalidAudio('Too many measured narration segments.');
  let previousEnd = 0;
  for (const segment of segments) {
    if (typeof segment.text !== 'string' || !segment.text.trim() || Array.from(segment.text).length > 300) {
      throw new EngineContractError('CAPTION_ALIGNMENT_REQUIRED', 'Each measured speech chunk must carry a nonblank transcript of at most 300 characters.');
    }
    if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs) || segment.startMs < 0 || segment.endMs <= segment.startMs || segment.startMs < previousEnd - 0.001 || segment.endMs > durationMs + 1) {
      invalidAudio('Narration segments must have real ordered timings inside the measured WAV.');
    }
    previousEnd = segment.endMs;
  }
  if (normalizeTranscript(segments.map((segment) => segment.text).join(' ')) !== normalizeTranscript(scene.narration)) invalidAudio('Measured segment text must preserve the approved transcript.');
  return segments;
}

export function buildTimeline({storyboard, audio, fps = 30, leadInFrames = 6, tailFrames = 6}) {
  validateStoryboard(storyboard);
  if (fps !== 30 || ![leadInFrames, tailFrames].every((value) => Number.isInteger(value) && value >= 0 && value <= 15)) {
    throw new EngineContractError('INVALID_TIMELINE_PROFILE', 'Use 30 FPS and bounded 0–15-frame scene lead/tail pauses.');
  }
  if (!Array.isArray(audio) || audio.length !== storyboard.scenes.length) invalidAudio('Exactly one measured audio entry is required per approved scene.');
  const audioById = new Map();
  for (const entry of audio) {
    if (!entry || typeof entry.sceneId !== 'string' || audioById.has(entry.sceneId) || !Number.isFinite(entry.durationMs) || entry.durationMs <= 0) invalidAudio('Audio entries require unique scene IDs and positive measured durations.');
    audioById.set(entry.sceneId, entry);
  }
  const rows = storyboard.scenes.map((scene) => {
    const entry = audioById.get(scene.sceneId);
    if (!entry) invalidAudio('An approved scene has no measured narration.');
    const durationMs = Math.ceil(entry.durationMs);
    const audioFrames = Math.ceil(durationMs * fps / 1000);
    return {scene, entry, segments: measuredSegments(scene, entry), durationMs, durationInFrames: leadInFrames + audioFrames + tailFrames};
  });
  let totalFrames = rows.reduce((total, row) => total + row.durationInFrames, 0);
  const targetFrames = storyboard.targetDurationSec * fps;
  const deficit = targetFrames - totalFrames;
  const paddingLimit = Math.min(MAX_TARGET_PADDING_SECONDS * fps, rows.length * Math.floor(MAX_EXTRA_PAUSE_PER_SCENE_SECONDS * fps));
  if (deficit > 0 && deficit <= paddingLimit) {
    for (let frame = 0; frame < deficit; frame++) rows[frame % rows.length].durationInFrames++;
    totalFrames += deficit;
  }
  if (Math.abs(totalFrames - targetFrames) > TARGET_TOLERANCE_SECONDS * fps) {
    throw new EngineContractError('DURATION_REVISION_REQUIRED', 'Measured narration does not fit the target. Revise the script and approve a new draft; audio was not clipped or sped up.', {targetDurationSec: storyboard.targetDurationSec, measuredDurationSec: totalFrames / fps});
  }
  let cursor = 0;
  const scenes = rows.map(({scene, entry, segments, durationMs, durationInFrames}) => {
    const startFrame = cursor;
    cursor += durationInFrames;
    const captionSegments = segments.map((segment) => ({
      startFrame: startFrame + leadInFrames + Math.ceil(segment.startMs * fps / 1000),
      endFrame: startFrame + leadInFrames + Math.ceil(segment.endMs * fps / 1000),
      text: normalizeTranscript(segment.text),
    }));
    if (captionSegments.some((cue) => cue.endFrame <= cue.startFrame)) invalidAudio('A measured narration chunk is shorter than the supported frame precision.');
    return {sceneId: scene.sceneId, startFrame, durationInFrames, audioAssetId: entry.audioAssetId ?? `audio_${scene.sceneId}`, audioOffsetInFrames: leadInFrames, measuredAudioDurationMs: durationMs, captionSegments};
  });
  const timeline = {schemaVersion: 1, fps, durationInFrames: totalFrames, scenes};
  return validateTimeline(storyboard, timeline);
}
