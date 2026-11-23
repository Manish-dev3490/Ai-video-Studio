import {ApiError} from '../http.js';
import {canonicalHash, validateStoryboard} from '../../../../packages/video-engine/src/contracts.js';
import {assertVisualQuality} from './visual-quality.js';

const initialSettings = Object.freeze({mode: 'FACELESS', language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'});
const settingsFields = [...Object.keys(initialSettings), 'durationSec', 'characterAssetId'];
const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const codePoints = value => Array.from(value).length;
export const invalid = (message = 'Check the project or storyboard fields and try again.') => new ApiError(422, 'VALIDATION_FAILED', message);

export function strictObject(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw invalid();
  return value;
}

export function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || codePoints(value.trim()) > maximum || forbiddenControls.test(value)) throw invalid(`Use a nonblank ${label} of at most ${maximum} characters.`);
  return value.trim();
}

export function validateSettings(input, {partial = false} = {}) {
  strictObject(input, settingsFields, partial ? [] : [...Object.keys(initialSettings), 'durationSec']);
  for (const [key, expected] of Object.entries(initialSettings)) {
    if (Object.hasOwn(input, key) && input[key] !== expected) throw new ApiError(422, 'FEATURE_UNAVAILABLE', 'Choose English faceless landscape educational motion graphics.');
  }
  if (Object.hasOwn(input, 'durationSec') && ![30, 60, 90].includes(input.durationSec)) throw invalid('Choose a 30, 60 or 90 second video.');
  if (Object.hasOwn(input, 'characterAssetId') && input.characterAssetId !== null) throw new ApiError(422, 'FEATURE_UNAVAILABLE', 'Character images are not enabled for this video profile.');
  return partial ? structuredClone(input) : {...initialSettings, durationSec: input.durationSec, characterAssetId: null};
}

export function validateProjectCreate(input) {
  strictObject(input, ['title', 'prompt', 'settings'], ['title', 'prompt', 'settings']);
  return {title: text(input.title, 120, 'title'), prompt: text(input.prompt, 2000, 'prompt'), settings: validateSettings(input.settings)};
}

export function validateProjectPatch(input) {
  strictObject(input, ['title', 'settings']);
  if (!Object.keys(input).length) throw invalid('Provide a title or settings to update.');
  return {...(Object.hasOwn(input, 'title') ? {title: text(input.title, 120, 'title')} : {}), ...(Object.hasOwn(input, 'settings') ? {settings: validateSettings(input.settings, {partial: true})} : {})};
}

export function validateRevision(input, {edit = false} = {}) {
  strictObject(input, edit ? ['expectedRevision', 'scenes'] : ['expectedRevision'], edit ? ['expectedRevision', 'scenes'] : ['expectedRevision']);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw invalid('Use the exact saved storyboard revision.');
  return input;
}

export function validateEmpty(input) {
  if (input === undefined) return;
  strictObject(input, []);
}

export const normalizeSettings = value => validateSettings(Object.fromEntries(settingsFields.filter(key => value[key] !== undefined).map(key => [key, value[key]])));
export const settingsHash = value => canonicalHash(normalizeSettings(value));
const iso = value => new Date(value).toISOString();
const nullableId = value => value ? String(value) : null;

export function publicProject(value) {
  return {id: String(value._id), title: value.title, prompt: value.prompt, settings: normalizeSettings(value.settings), phase: value.phase, currentStoryboardId: nullableId(value.currentStoryboardId), latestGenerationId: nullableId(value.latestGenerationId), latestOutputAssetId: nullableId(value.latestOutputAssetId), createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt)};
}

export function publicStoryboard(value) {
  return {id: String(value._id), projectId: String(value.projectId), revision: value.revision, status: value.status, schemaVersion: value.schemaVersion, targetDurationSec: value.targetDurationSec, settingsSnapshot: normalizeSettings(value.settingsSnapshot), scenes: structuredClone(value.scenes), parentStoryboardId: nullableId(value.parentStoryboardId), approvedAt: value.approvedAt ? iso(value.approvedAt) : null, createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt)};
}

export function assertVisualDensity(storyboard) {
  const check = (value, maximum, field) => {
    if (typeof value !== 'string') return;
    if (codePoints(value) > maximum || value.split(/\s+/u).some(word => codePoints(word) > 40)) throw new ApiError(422, 'LAYOUT_TOO_DENSE', 'Shorten visual labels so they remain readable at 720p.', {details: {field, maximumCharacters: maximum, maximumUnbrokenWordCharacters: 40}});
  };
  for (const [index, scene] of storyboard.scenes.entries()) {
    const props = scene.visualProps;
    const field = `scenes[${index}].visualProps`;
    check(props.title, 70, field + '.title');
    check(props.subtitle, 180, field + '.subtitle');
    for (const name of ['steps', 'points']) for (const value of props[name] || []) check(value, 180, field + '.' + name);
    for (const value of props.items || []) check(value, 80, field + '.items');
    if (scene.template === 'FLOWCHART') {
      for (const node of props.nodes) check(node.label, 60, field + '.nodes.label');
      for (const edge of props.edges) check(edge.label, 60, field + '.edges.label');
    }
  }
  assertVisualQuality(storyboard);
}

export function assertNarrationBudget(storyboard) {
  const recommended = {30: 66, 60: 134, 90: 200}[storyboard.targetDurationSec];
  const words = storyboard.scenes.map(scene => scene.narration.trim()).join(' ').split(/\s+/u).filter(Boolean).length;
  if (words < Math.floor(recommended * 0.7) || words > Math.ceil(recommended * 1.3)) throw new ApiError(422, 'NARRATION_BUDGET', 'Adjust the narration length before approval. Actual speech timing is checked during rendering.', {details: {targetDurationSec: storyboard.targetDurationSec, words, approximateTargetWords: recommended}});
}

export function validateDraft(value, {provider = false} = {}) {
  try { validateStoryboard(value, {requireApproved: false}); assertVisualDensity(value); return value; }
  catch (error) {
    if (provider) throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The AI returned an invalid storyboard. Try a clearer or shorter topic.', {retryable: true});
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, error.code === 'FEATURE_UNAVAILABLE' ? error.code : 'INVALID_STORYBOARD', 'Check the complete scene list, visual labels and narration before saving.');
  }
}

export function draftFromPlanning(output, {id, projectId, settings, now = new Date()}) {
  try {
    strictObject(output, ['schemaVersion', 'targetDurationSec', 'scenes'], ['schemaVersion', 'targetDurationSec', 'scenes']);
    const value = {id: String(id), projectId: String(projectId), revision: 1, status: 'DRAFT', schemaVersion: output.schemaVersion, targetDurationSec: output.targetDurationSec, settingsSnapshot: normalizeSettings(settings), scenes: structuredClone(output.scenes), parentStoryboardId: null, approvedAt: null, createdAt: iso(now), updatedAt: iso(now)};
    validateDraft(value, {provider: true});
    assertNarrationBudget(value);
    return value;
  } catch (error) {
    if (error instanceof ApiError && error.status === 502) throw error;
    throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The AI returned an invalid storyboard. Try a clearer or shorter topic.', {retryable: true});
  }
}
