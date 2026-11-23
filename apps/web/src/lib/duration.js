const objectId = value => typeof value === 'string' && /^[a-f0-9]{24}$/u.test(value);
export const durationRevisionRequired = job => job?.status === 'FAILED' && job.error?.code === 'DURATION_REVISION_REQUIRED';
export const narrationWordCount = scenes => (Array.isArray(scenes) ? scenes : []).reduce((total, scene) => total + (typeof scene.narration === 'string' ? scene.narration.trim().split(/\s+/u).filter(Boolean).length : 0), 0);
export const durationRoute = (projectId, generationId) => `/app/projects/${encodeURIComponent(projectId)}/review?durationSource=${encodeURIComponent(generationId)}`;
export const uncertainDurationOutcome = failure => ['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'].includes(failure?.status) || Number(failure?.status) >= 500;
export function durationRequest(projectId, job) {
  if (!objectId(projectId) || !objectId(job?.id) || job.projectId !== projectId || !objectId(job.storyboardId) || !Number.isSafeInteger(job.approvedRevision) || job.approvedRevision < 1 || !durationRevisionRequired(job)) throw new Error('Open an owned duration-mismatch attempt before revising its narration.');
  return {projectId, generationId: job.id, storyboardId: job.storyboardId, expectedRevision: job.approvedRevision};
}
export function durationCorrectionAvailable({project, storyboard, job, dirty = false}) {
  return !dirty && durationRevisionRequired(job) && project?.phase !== 'RENDERING' && project?.id === job.projectId && project.currentStoryboardId === job.storyboardId && (!storyboard || storyboard.id === job.storyboardId && storyboard.status === 'APPROVED' && storyboard.revision === job.approvedRevision);
}
export function checkedDurationFeedback(value, job) {
  if (value?.available !== true || value.generationId !== job?.id || value.projectId !== job.projectId || value.storyboardId !== job.storyboardId || value.approvedRevision !== job.approvedRevision || ![30, 60, 90].includes(value.targetDurationSec) || !Number.isFinite(value.measuredDurationSec) || value.measuredDurationSec <= 0 || value.measuredDurationSec > 1800 || !['narrationWords', 'sceneCount', 'suggestedNarrationWords'].every(key => Number.isSafeInteger(value[key]) && value[key] > 0) || value.narrationWords > 5000 || value.suggestedNarrationWords > 5000 || value.sceneCount > 18 || !['SHORTEN', 'EXPAND'].includes(value.direction) || value.correctedStoryboardId !== null && !objectId(value.correctedStoryboardId)) return null;
  return value;
}

// Reset fences survive same-owner logout/login and cross-tab cache resets.
let privacyVersion = 0;
const listeners = new Set();
export const durationPrivacyVersion = () => privacyVersion;
export function subscribeDurationPrivacy(listener) {listeners.add(listener); return () => listeners.delete(listener);}
export function clearDurationRequests() {privacyVersion++; for (const listener of [...listeners]) listener();}
