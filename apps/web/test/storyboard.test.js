import test from 'node:test';
import assert from 'node:assert/strict';
import {activeGeneration, admissionKey, assetAvailable, assetUrl, defaultSettings, defaultVisualProps, editorErrors, forgetAdmission, generationPollInterval, generateScriptWithRecovery, moveScene, projectRoute, retryAllowed, stageOrder, storyboardSelected} from '../src/lib/storyboard.js';

const scene = (id, template = 'TITLE') => ({sceneId: id, template, narration: 'A short narrated explanation.', estimatedDurationSec: 5, visualProps: defaultVisualProps(template, 'A clear visual title')});

test('the review editor uses the current 70-character visual-title limit', () => {
  const value = scene('title'); value.visualProps.title = 'A '.repeat(35).trim();
  assert.deepEqual(editorErrors([value, scene('second')]), []);
  value.visualProps.title += ' A';
  assert.ok(editorErrors([value, scene('second')]).some(error => error.includes('1–70')));
});

test('moving scenes preserves immutable IDs/content and refuses out-of-range positions', () => {
  const original = [scene('first'), scene('second'), scene('third')];
  const moved = moveScene(original, 0, 1);
  assert.deepEqual(moved.map(item => item.sceneId), ['second', 'first', 'third']);
  assert.deepEqual(original.map(item => item.sceneId), ['first', 'second', 'third']);
  assert.equal(moveScene(original, 0, -1), original);
});

test('editor catches invalid revisions-to-save data before it can become an approval', () => {
  assert.deepEqual(editorErrors([scene('one'), scene('two')]), []);
  assert.ok(editorErrors([scene('one')]).length);
  assert.ok(editorErrors([scene('same'), scene('same')]).length);
  assert.ok(editorErrors([{...scene('one'), narration: ' '}, scene('two')]).length);
  assert.ok(editorErrors([{...scene('one'), estimatedDurationSec: NaN}, scene('two')]).length);
  assert.ok(editorErrors([{...scene('one'), template: 'SCRIPT_CODE'}, scene('two')]).length);
  assert.ok(editorErrors([{...scene('one'), visualProps: {title: 'W'.repeat(81)}}, scene('two')]).length);
});

test('supported visual defaults include complete matching template props and valid graph endpoints', () => {
  for (const template of ['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS']) assert.equal(defaultVisualProps(template).title, 'New scene');
  const graph = defaultVisualProps('FLOWCHART');
  assert.ok(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to)));
  assert.throws(() => defaultVisualProps('IMAGE_WITH_LABELS'));
  assert.deepEqual(defaultSettings(60), {mode: 'FACELESS', durationSec: 60, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'});
});

test('only active job states poll; revision-required failures cannot retry the same snapshot', () => {
  for (const status of ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED']) assert.equal(activeGeneration({status}), true);
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) assert.equal(activeGeneration({status}), false);
  assert.equal(retryAllowed({status: 'CANCELLED'}), true);
  assert.equal(retryAllowed({status: 'FAILED', error: {retryable: true, code: 'MEDIA_TOOL_FAILED'}}), true);
  assert.equal(retryAllowed({status: 'FAILED', error: {retryable: false}}), false);
  assert.equal(retryAllowed({status: 'FAILED', error: {retryable: true, code: 'DURATION_REVISION_REQUIRED'}}), false);
  assert.equal(stageOrder.length, 6);
});

test('asset controls require READY, AVAILABLE and an unexpired export; paths stay same-origin', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const ready = {status: 'READY', availability: 'AVAILABLE', expiresAt: '2026-11-22T12:00:00Z'};
  assert.equal(assetAvailable(ready, now), true);
  assert.equal(assetAvailable({...ready, availability: 'EXPIRED'}, now), false);
  assert.equal(assetAvailable({...ready, status: 'DELETED'}, now), false);
  assert.equal(assetAvailable({...ready, expiresAt: '2026-11-21T12:00:00Z'}, now), false);
  assert.equal(assetAvailable({...ready, expiresAt: 'invalid'}, now), false);
  assert.equal(assetUrl('https://external.example/file'), '/api/v1/assets/https%3A%2F%2Fexternal.example%2Ffile/download');
});

test('polling honors longer Retry-After values and stops for terminal or inaccessible jobs', () => {
  assert.equal(generationPollInterval({status: 'PROCESSING'}), 3000);
  assert.equal(generationPollInterval({status: 'PROCESSING'}, {status: 429, retryAfter: 180}), 180000);
  assert.equal(generationPollInterval({status: 'COMPLETED'}, {status: 429, retryAfter: 180}), 0);
  assert.equal(generationPollInterval(null, {status: 404}), 0);
  assert.equal(generationPollInterval(null, {status: 503}), 3000);
});

test('project cards route to actual render/preview/review rather than placeholder pages', () => {
  assert.equal(projectRoute({id: 'p', phase: 'DRAFT'}), '/app/projects/p/review');
  assert.equal(projectRoute({id: 'p', phase: 'RENDERING', latestGenerationId: 'g'}), '/app/projects/p/generating?generation=g');
  assert.equal(projectRoute({id: 'p', phase: 'HAS_OUTPUT', latestOutputAssetId: 'asset'}), '/app/projects/p/preview');
});

test('cleared or changed project selection cannot reuse an older approved storyboard', () => {
  const storyboard = {id: 'approved-one', status: 'APPROVED', settingsSnapshot: {...defaultSettings(30), characterAssetId: null}};
  const project = {currentStoryboardId: storyboard.id, settings: defaultSettings(30)};
  assert.equal(storyboardSelected(project, storyboard), true);
  assert.equal(storyboardSelected({...project, currentStoryboardId: null}, storyboard), false);
  assert.equal(storyboardSelected({...project, currentStoryboardId: 'new-draft'}, storyboard), false);
  assert.equal(storyboardSelected({...project, settings: defaultSettings(60)}, storyboard), false);
});

test('uncertain render submission retains its idempotency key until a receipt is accepted', () => {
  const first = admissionKey('test-action');
  assert.equal(admissionKey('test-action'), first);
  assert.ok(admissionKey('different-action') !== first);
  forgetAdmission('test-action');
  assert.ok(admissionKey('test-action') !== first);
});

test('successful script generation does not perform recovery reads', async () => {
  let submissions = 0, reads = 0;
  const storyboard = {id: 'new-draft'};
  const result = await generateScriptWithRecovery({projectId: 'project', generate: async () => {submissions++; return storyboard;}, readProject: async () => {reads++;}, readCurrentStoryboard: async () => {reads++;}});
  assert.equal(result.storyboard, storyboard); assert.equal(result.recovered, false); assert.equal(submissions, 1); assert.equal(reads, 0);
});

test('a dropped script response recovers its newly saved draft without a second AI submission', async () => {
  const dropped = {status: 'FETCH_ERROR'}, projectId = 'project';
  const storyboard = {id: 'new-draft', projectId, status: 'DRAFT', settingsSnapshot: defaultSettings(90)};
  let submissions = 0, projectReads = 0, draftReads = 0;
  const result = await generateScriptWithRecovery({projectId, previousStoryboardId: 'earlier-draft', generate: async () => {submissions++; throw dropped;}, readProject: async () => {projectReads++; return {id: projectId, currentStoryboardId: storyboard.id, settings: defaultSettings(90)};}, readCurrentStoryboard: async () => {draftReads++; return storyboard;}});
  assert.equal(result.storyboard, storyboard); assert.equal(result.recovered, true); assert.deepEqual([submissions, projectReads, draftReads], [1, 1, 1]);
});

test('failed script recovery never accepts an old, unrelated or stale draft or replaces the original failure', async () => {
  const failure = {status: 'PARSING_ERROR', originalStatus: 502};
  const project = {id: 'project', currentStoryboardId: 'new-draft', settings: defaultSettings(90)};
  const storyboard = {id: 'new-draft', projectId: 'project', status: 'DRAFT', settingsSnapshot: defaultSettings(90)};
  for (const scenario of [
    {project: {...project, currentStoryboardId: 'earlier-draft'}}, {project: {...project, currentStoryboardId: null}}, {project: {...project, id: 'another-project'}},
    {storyboard: {...storyboard, id: 'unselected-draft'}}, {storyboard: {...storyboard, projectId: 'another-project'}}, {storyboard: {...storyboard, status: 'APPROVED'}}, {storyboard: {...storyboard, settingsSnapshot: defaultSettings(60)}},
    {projectFailure: true}, {draftFailure: true},
  ]) {
    let submissions = 0, projectReads = 0, draftReads = 0;
    await assert.rejects(generateScriptWithRecovery({projectId: 'project', previousStoryboardId: 'earlier-draft', generate: async () => {submissions++; throw failure;}, readProject: async () => {projectReads++; if (scenario.projectFailure) throw new Error('read failed'); return scenario.project || project;}, readCurrentStoryboard: async () => {draftReads++; if (scenario.draftFailure) throw new Error('read failed'); return scenario.storyboard || storyboard;}}), error => error === failure);
    assert.equal(submissions, 1); assert.equal(projectReads, 1); assert.ok(draftReads <= 1);
  }
});
