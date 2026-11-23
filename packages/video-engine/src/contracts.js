import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const SUPPORTED_TEMPLATES = Object.freeze(['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS']);
export const OUTPUT_PROFILE = Object.freeze({width: 1280, height: 720, fps: 30});
export const TARGET_TOLERANCE_SECONDS = 5;

export class EngineContractError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'EngineContractError';
    this.code = code;
    this.retryable = false;
    if (details !== undefined) this.details = details;
  }
}

const schemaUrl = new URL('../../../review/phase-1-contracts/schemas/scene.schema.json', import.meta.url);
const sceneSchema = JSON.parse(readFileSync(schemaUrl, 'utf8'));
const ajv = new Ajv2020({allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false});
addFormats(ajv);
ajv.addSchema(sceneSchema, schemaUrl.href);
const storyboardValidator = ajv.getSchema(`${schemaUrl.href}#/$defs/Storyboard`);
const timelineValidator = ajv.getSchema(`${schemaUrl.href}#/$defs/RenderTimeline`);
const captionValidator = ajv.getSchema(`${schemaUrl.href}#/$defs/WebVttCaptionTrack`);

function checkSchema(validate, input, code, message) {
  if (!validate(input)) {
    throw new EngineContractError(code, message, validate.errors.map(({instancePath, keyword, message: errorMessage}) => ({instancePath, keyword, message: errorMessage})));
  }
  return input;
}

export const normalizeTranscript = (text) => text.replace(/\s+/gu, ' ').trim();
const codePointLength = (text) => Array.from(text).length;
const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function checkInertText(value) {
  if (typeof value === 'string' && forbiddenControls.test(value)) {
    throw new EngineContractError('INVALID_STORYBOARD', 'Text contains unsupported control characters.');
  }
  if (Array.isArray(value)) value.forEach(checkInertText);
  else if (value && typeof value === 'object') Object.values(value).forEach(checkInertText);
}

/** Validate shape plus the capabilities actually implemented by this engine. */
export function validateStoryboard(storyboard, {requireApproved = true} = {}) {
  checkSchema(storyboardValidator, storyboard, 'INVALID_STORYBOARD', 'Storyboard does not match the canonical scene contract.');
  if (requireApproved && storyboard.status !== 'APPROVED') {
    throw new EngineContractError('STORYBOARD_NOT_APPROVED', 'Approve the exact saved storyboard before narration or rendering.');
  }
  const settings = storyboard.settingsSnapshot;
  if (settings.mode !== 'FACELESS' || settings.language !== 'en' || settings.aspectRatio !== '16:9' || settings.tone !== 'EDUCATIONAL' || settings.visualStyle !== 'MOTION_GRAPHICS' || settings.characterAssetId != null) {
    throw new EngineContractError('FEATURE_UNAVAILABLE', 'This engine currently supports English faceless 16:9 educational motion graphics only.');
  }
  if (settings.durationSec !== storyboard.targetDurationSec) {
    throw new EngineContractError('INVALID_STORYBOARD', 'Target duration must match the approved settings snapshot.');
  }
  checkInertText(storyboard);
  const ids = new Set();
  let narrationLength = 0;
  for (const scene of storyboard.scenes) {
    if (ids.has(scene.sceneId)) throw new EngineContractError('INVALID_STORYBOARD', 'Scene IDs must be unique.');
    ids.add(scene.sceneId);
    if (!SUPPORTED_TEMPLATES.includes(scene.template)) {
      throw new EngineContractError('FEATURE_UNAVAILABLE', `Template ${scene.template} is not enabled in this engine.`);
    }
    if (scene.assetIds?.length) {
      throw new EngineContractError('FEATURE_UNAVAILABLE', 'External media references are not enabled for the initial five templates.');
    }
    narrationLength += codePointLength(scene.narration);
    if (scene.template === 'FLOWCHART') {
      const nodes = new Set(scene.visualProps.nodes.map((node) => node.id));
      if (nodes.size !== scene.visualProps.nodes.length || scene.visualProps.edges.some((edge) => !nodes.has(edge.from) || !nodes.has(edge.to))) {
        throw new EngineContractError('INVALID_STORYBOARD', 'Flowchart nodes must be unique and every edge must reference existing nodes.');
      }
    }
  }
  if (narrationLength > 6000) throw new EngineContractError('INVALID_STORYBOARD', 'Complete narration exceeds the approved 6000-character cap.');
  return storyboard;
}

export function validateTimelineShape(timeline) {
  return checkSchema(timelineValidator, timeline, 'INVALID_TIMELINE', 'Timeline does not match the canonical measured-timing contract.');
}

export function validateCaptionTrack(track) {
  return checkSchema(captionValidator, track, 'INVALID_CAPTIONS', 'Caption track does not match the canonical sidecar contract.');
}

/** This checks data coherence; callers must probe the actual files separately. */
export function validateTimeline(storyboard, timeline) {
  validateStoryboard(storyboard);
  validateTimelineShape(timeline);
  if (timeline.scenes.length !== storyboard.scenes.length) throw new EngineContractError('INVALID_TIMELINE', 'Timeline and storyboard scene counts differ.');
  let cursor = 0;
  let previousCaptionEnd = 0;
  for (let index = 0; index < storyboard.scenes.length; index++) {
    const approved = storyboard.scenes[index];
    const measured = timeline.scenes[index];
    if (measured.sceneId !== approved.sceneId || measured.startFrame !== cursor) {
      throw new EngineContractError('INVALID_TIMELINE', 'Scene order and contiguous frame windows must follow the approved storyboard.');
    }
    const audioStart = measured.startFrame + measured.audioOffsetInFrames;
    const audioEnd = audioStart + Math.ceil(measured.measuredAudioDurationMs * timeline.fps / 1000);
    if (audioEnd > measured.startFrame + measured.durationInFrames) throw new EngineContractError('INVALID_TIMELINE', 'A scene would clip its measured narration.');
    for (const cue of measured.captionSegments) {
      if (cue.startFrame < audioStart || cue.endFrame > audioEnd || cue.endFrame <= cue.startFrame || cue.startFrame < previousCaptionEnd) {
        throw new EngineContractError('INVALID_TIMELINE', 'Caption boundaries must be ordered, non-overlapping and inside their measured audio window.');
      }
      previousCaptionEnd = cue.endFrame;
    }
    if (normalizeTranscript(measured.captionSegments.map((cue) => cue.text).join(' ')) !== normalizeTranscript(approved.narration)) {
      throw new EngineContractError('INVALID_TIMELINE', 'Caption transcript does not match approved narration.');
    }
    cursor += measured.durationInFrames;
  }
  if (cursor !== timeline.durationInFrames) throw new EngineContractError('INVALID_TIMELINE', 'Timeline total must equal its final scene end.');
  const durationSeconds = timeline.durationInFrames / timeline.fps;
  if (Math.abs(durationSeconds - storyboard.targetDurationSec) > TARGET_TOLERANCE_SECONDS + 1e-9) {
    throw new EngineContractError('DURATION_REVISION_REQUIRED', 'Measured narration does not fit the selected duration. Review and approve a corrected draft.', {targetDurationSec: storyboard.targetDurationSec, measuredDurationSec: durationSeconds});
  }
  return timeline;
}

/** Deterministic JSON for finite JSON data. This is not a general JS serializer. */
export function canonicalJson(value) {
  const ancestors = new Set();
  const encode = (item, depth) => {
    if (depth > 100) throw new EngineContractError('INVALID_JSON', 'JSON nesting exceeds the engine limit.');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new EngineContractError('INVALID_JSON', 'Only finite JSON numbers can be hashed.');
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object' || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null && !Array.isArray(item))) {
      throw new EngineContractError('INVALID_JSON', 'Only plain JSON values can be hashed.');
    }
    if (ancestors.has(item)) throw new EngineContractError('INVALID_JSON', 'Circular input cannot be hashed.');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Array.from({length: item.length}, (_, index) => Object.hasOwn(item, index)).some((present) => !present)) throw new EngineContractError('INVALID_JSON', 'Sparse or augmented arrays cannot be hashed.');
      result = `[${item.map((child) => encode(child, depth + 1)).join(',')}]`;
    } else {
      if (Object.getOwnPropertySymbols(item).length) throw new EngineContractError('INVALID_JSON', 'Symbol properties cannot be hashed.');
      result = `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  };
  return encode(value, 0);
}

export function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Hash render-relevant approved content, excluding mutable UI metadata. */
export function hashApprovedStoryboard(storyboard) {
  validateStoryboard(storyboard);
  return canonicalHash({schemaVersion: storyboard.schemaVersion, targetDurationSec: storyboard.targetDurationSec, settingsSnapshot: storyboard.settingsSnapshot, scenes: storyboard.scenes});
}
