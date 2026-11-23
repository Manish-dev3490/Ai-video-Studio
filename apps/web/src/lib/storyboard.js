export const templateNames = {TITLE: 'Title', STEPS: 'Steps', STACK_QUEUE: 'Stack / queue', FLOWCHART: 'Flowchart', KEY_POINTS: 'Key points'};
export const stageNames = {PREPARE_ASSETS: 'Preparing assets', SYNTHESIZE_AUDIO: 'Synthesizing narration', ALIGN_TIMELINE: 'Aligning scenes', RENDER_VIDEO: 'Rendering video', VALIDATE_OUTPUT: 'Validating output', UPLOAD_OUTPUT: 'Publishing video and captions'};
export const stageOrder = Object.keys(stageNames);
export const activeGeneration = job => Boolean(job && ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED'].includes(job.status));
export function generationPollInterval(job, error) {
  if (job && !activeGeneration(job) || [401, 403, 404].includes(error?.status)) return 0;
  if (error?.status === 429) {
    const seconds = Number(error.retryAfter);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400000, Math.max(3000, seconds * 1000)) : 3000;
  }
  return 3000;
}
export const retryAllowed = job => Boolean(job && (job.status === 'CANCELLED' || (job.status === 'FAILED' && job.error?.retryable === true && !['DURATION_REVISION_REQUIRED', 'REVISION_REQUIRED'].includes(job.error.code))));
export const assetUrl = id => `/api/v1/assets/${encodeURIComponent(id)}/download`;
export const assetAvailable = (asset, now = Date.now()) => Boolean(asset && asset.status === 'READY' && asset.availability === 'AVAILABLE' && Number.isFinite(Date.parse(asset.expiresAt)) && Date.parse(asset.expiresAt) > now);
export const defaultSettings = durationSec => ({mode: 'FACELESS', durationSec, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'});
export function storyboardSelected(project, storyboard) {
  if (!project || !storyboard || project.currentStoryboardId !== storyboard.id) return false;
  return ['mode', 'durationSec', 'language', 'aspectRatio', 'tone', 'visualStyle', 'characterAssetId'].every(key => (project.settings?.[key] ?? null) === (storyboard.settingsSnapshot?.[key] ?? null));
}
/** Recover a lost response using saved state, without another AI submission. */
export async function generateScriptWithRecovery({generate, projectId, previousStoryboardId, readProject, readCurrentStoryboard}) {
  try {return {storyboard: await generate(), recovered: false};}
  catch (failure) {
    try {
      const project = await readProject();
      if (project?.id === projectId && project.currentStoryboardId && project.currentStoryboardId !== previousStoryboardId) {
        const storyboard = await readCurrentStoryboard();
        if (storyboard?.status === 'DRAFT' && storyboard.projectId === projectId && storyboardSelected(project, storyboard)) return {storyboard, recovered: true};
      }
    } catch { /* Keep the original failure when saved state is unavailable. */ }
    throw failure;
  }
}
export const projectRoute = project => project.phase === 'RENDERING' && project.latestGenerationId ? `/app/projects/${encodeURIComponent(project.id)}/generating?generation=${encodeURIComponent(project.latestGenerationId)}` : project.phase === 'HAS_OUTPUT' && project.latestOutputAssetId ? `/app/projects/${encodeURIComponent(project.id)}/preview` : `/app/projects/${encodeURIComponent(project.id)}/review`;
export const sceneText = scene => scene.visualProps.title || templateNames[scene.template] || 'Scene';
export function defaultVisualProps(template, title = 'New scene') {
  if (template === 'TITLE') return {title};
  if (template === 'STEPS') return {title, steps: ['First step', 'Next step']};
  if (template === 'KEY_POINTS') return {title, points: ['Key idea']};
  if (template === 'STACK_QUEUE') return {title, items: ['First item'], layout: 'STACK'};
  if (template === 'FLOWCHART') return {title, nodes: [{id: 'start', label: 'Start'}, {id: 'finish', label: 'Finish'}], edges: [{from: 'start', to: 'finish'}]};
  throw new Error('Choose a supported scene template.');
}
export function moveScene(scenes, index, change) {
  const target = index + change;
  if (!Number.isInteger(index) || !Number.isInteger(target) || index < 0 || target < 0 || index >= scenes.length || target >= scenes.length) return scenes;
  const copy = [...scenes];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy;
}
export function editorErrors(scenes) {
  if (!Array.isArray(scenes) || scenes.length < 2 || scenes.length > 18) return ['Use 2–18 scenes.'];
  const errors = [];
  const ids = new Set();
  let narration = 0;
  for (const [index, scene] of scenes.entries()) {
    if (!scene.sceneId || ids.has(scene.sceneId)) errors.push(`Scene ${index + 1} needs a unique identifier.`);
    ids.add(scene.sceneId);
    if (!templateNames[scene.template]) errors.push(`Scene ${index + 1} uses an unavailable template.`);
    const count = Array.from(scene.narration || '').length;
    narration += count;
    if (!scene.narration?.trim() || count > 1200) errors.push(`Scene ${index + 1}: narration must contain 1–1,200 characters.`);
    if (!Number.isFinite(scene.estimatedDurationSec) || scene.estimatedDurationSec <= 0) errors.push(`Scene ${index + 1} needs a positive duration estimate.`);
    if (!scene.visualProps?.title?.trim() || Array.from(scene.visualProps.title).length > 70) errors.push(`Scene ${index + 1}: visual title must contain 1–70 characters.`);
  }
  if (narration > 6000) errors.push('Combined narration must not exceed 6,000 characters.');
  return errors;
}
// A failed/uncertain submission keeps its key for an exact replay within this
// running app. A completed admission removes it; no auth credential is stored.
const admissionKeys = new Map();
export function admissionKey(action) {
  if (!admissionKeys.has(action)) admissionKeys.set(action, globalThis.crypto.randomUUID());
  return admissionKeys.get(action);
}
export const forgetAdmission = action => admissionKeys.delete(action);
