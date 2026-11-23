import {canonicalHash, hashApprovedStoryboard} from '../../../../packages/video-engine/src/contracts.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const narrationWords = storyboard => storyboard.scenes.map(scene => scene.narration.trim()).join(' ').split(/\s+/u).filter(Boolean).length;

/** Only the fixed engine duration error may cross the private child boundary. */
export function safeDurationMeasurement(value, expectedTarget) {
  if (!object(value) || ![30, 60, 90].includes(value.targetDurationSec) || expectedTarget !== undefined && value.targetDurationSec !== expectedTarget || !Number.isFinite(value.measuredDurationSec) || value.measuredDurationSec <= 0 || value.measuredDurationSec > 3600 || Math.abs(value.targetDurationSec - value.measuredDurationSec) <= 5) return null;
  return {targetDurationSec: value.targetDurationSec, measuredDurationSec: value.measuredDurationSec};
}

/** A stored measurement is bound to the exact frozen, approved input. */
export function trustedDurationFeedback(job) {
  const value = job?.manifest?.durationFeedback;
  if (job?.status !== 'FAILED' || job.error?.code !== 'DURATION_REVISION_REQUIRED' || value?.measurementVersion !== 1 || !job.snapshot || !safeDurationMeasurement(value, job.snapshot.targetDurationSec)) return null;
  try {
    const hash = hashApprovedStoryboard(job.snapshot);
    if (job.storyboardHash !== hash || value.sourceStoryboardHash !== hash || String(job.snapshot.id) !== String(job.storyboardId) || job.snapshot.revision !== job.approvedRevision || value.narrationWords !== narrationWords(job.snapshot) || value.sceneCount !== job.snapshot.scenes.length) return null;
    if (!Array.isArray(value.sceneAudioDurationMs) || value.sceneAudioDurationMs.length !== value.sceneCount || !value.sceneAudioDurationMs.every(time => Number.isSafeInteger(time) && time > 0 && time <= 120000)) return null;
    const frames = value.sceneAudioDurationMs.reduce((sum, time) => sum + 12 + Math.ceil(time * 30 / 1000), 0);
    if (Math.abs(frames / 30 - value.measuredDurationSec) > 0.000001 || value.voice !== 'af_heart' || value.speed !== 1 || value.language !== 'en') return null;
    const pauseSeconds = value.sceneCount * 0.4;
    const prior = value.narrationWords;
    const recommended = {30: 68, 60: 140, 90: 210}[value.targetDurationSec];
    const adjusted = Math.round(prior * Math.max(1, value.targetDurationSec - pauseSeconds) / Math.max(1, value.measuredDurationSec - pauseSeconds));
    // The existing approval budget remains authoritative; a hint is not a promise.
    const existingBudget = {30: 66, 60: 134, 90: 200}[value.targetDurationSec];
    const suggested = Math.max(Math.floor(existingBudget * 0.7), Math.min(Math.ceil(existingBudget * 1.3), adjusted));
    return {targetDurationSec: value.targetDurationSec, measuredDurationSec: value.measuredDurationSec, narrationWords: prior, sceneCount: value.sceneCount, suggestedNarrationWords: suggested, direction: value.measuredDurationSec > value.targetDurationSec ? 'SHORTEN' : 'EXPAND', approximateInitialWords: recommended};
  } catch {return null;}
}

export function sameDurationRevisionVisuals(source, output) {
  try {return output?.scenes?.length === source.scenes.length && output.scenes.every((scene, index) => {
    const original = source.scenes[index];
    return scene.sceneId === original.sceneId && scene.template === original.template && canonicalHash(scene.visualProps) === canonicalHash(original.visualProps);
  });} catch {return false;}
}

export function sanitizeDurationEvidence(value, storyboard) {
  try {
    const job = {status: 'FAILED', error: {code: 'DURATION_REVISION_REQUIRED'}, snapshot: storyboard, storyboardId: storyboard.id, approvedRevision: storyboard.revision, storyboardHash: hashApprovedStoryboard(storyboard), manifest: {durationFeedback: value}};
    if (!trustedDurationFeedback(job)) return null;
    return {measurementVersion: 1, sourceStoryboardHash: job.storyboardHash, targetDurationSec: value.targetDurationSec, measuredDurationSec: value.measuredDurationSec, narrationWords: value.narrationWords, sceneCount: value.sceneCount, sceneAudioDurationMs: [...value.sceneAudioDurationMs], voice: 'af_heart', speed: 1, language: 'en'};
  } catch {return null;}
}
