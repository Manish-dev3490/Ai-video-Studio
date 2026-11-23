import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {createProjectServices} from '../src/projects/index.js';
import {hashApprovedStoryboard} from '../../../packages/video-engine/src/contracts.js';
import {narrationWords} from '../src/projects/duration-feedback.js';
import {createGenerationService} from '../src/jobs/service.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8'));
for (const scene of fixture.scenes) if (scene.template === 'FLOWCHART') {
  scene.visualProps.nodes = scene.visualProps.nodes.slice(0, 4);
  scene.visualProps.edges = scene.visualProps.nodes.slice(1).map((node, index) => ({from: scene.visualProps.nodes[index].id, to: node.id}));
}
const owner = String(new mongoose.Types.ObjectId()), other = String(new mongoose.Types.ObjectId());
const config = {geminiTimeoutMs: 1000, planningMaxAttempts: 1};
const plan = () => ({schemaVersion: 1, targetDurationSec: 30, scenes: structuredClone(fixture.scenes)});
let connection, mongo, models;
before(async () => {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
  const directory = path.join(root, 'var/phase8-tests', 'duration-transactions-' + randomUUID());
  mongo = await startLocalMongo({directory, port, replicaSet: 'durationTests'});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/duration_tests?replicaSet=durationTests`).asPromise();
  models = createStudioModels(connection); await initializeStudioModels(models);
});
after(async () => {if (connection) await connection.close(); if (mongo) await mongo.stop();});
const service = planner => createProjectServices({connection, config, models, planner: planner || (async () => plan())});
function corrected(input) {
  const value = plan(), target = input.durationRevision.feedback.suggestedNarrationWords;
  const words = ['A', 'clear', 'educational', 'example', 'explains', 'the', 'event', 'loop', 'and', 'ordinary', 'scheduled', 'work'];
  for (const [index, scene] of value.scenes.entries()) {
    const count = Math.floor(target / value.scenes.length) + (index < target % value.scenes.length ? 1 : 0);
    scene.narration = Array.from({length: count}, (_, offset) => words[offset % words.length]).join(' ') + '.';
  }
  return value;
}
async function source() {
  const api = service();
  const project = await api.create(owner, {title: 'Measured duration test', prompt: 'Explain the JavaScript event loop.', settings: fixture.settingsSnapshot});
  const draft = await api.generate(owner, project.id, {});
  await api.approve(owner, project.id, draft.id, {expectedRevision: 1});
  const snapshot = await api.getStoryboard(owner, project.id, draft.id);
  const hash = hashApprovedStoryboard(snapshot);
  const job = await models.GenerationJob.create({ownerId: owner, projectId: project.id, storyboardId: draft.id, approvedRevision: 1, status: 'FAILED', snapshot, storyboardHash: hash, error: {code: 'DURATION_REVISION_REQUIRED', message: 'Safe generic failure', retryable: false}, manifest: {durationFeedback: {measurementVersion: 1, sourceStoryboardHash: hash, targetDurationSec: 30, measuredDurationSec: 41.6, narrationWords: narrationWords(snapshot), sceneCount: 4, sceneAudioDurationMs: [10000, 10000, 10000, 10000], voice: 'af_heart', speed: 1, language: 'en'}}});
  return {project, snapshot, job, body: {generationId: String(job._id), storyboardId: draft.id, expectedRevision: 1}};
}

test('measured correction creates a new unapproved draft and idempotently recovers its saved result', async () => {
  const state = await source(); let calls = 0;
  const api = service(async input => {calls++; assert.deepEqual(input.durationRevision.scenes, state.snapshot.scenes); return corrected(input);});
  const draft = await api.reviseDuration(owner, state.project.id, state.body);
  assert.equal(draft.status, 'DRAFT'); assert.equal(draft.approvedAt, null); assert.equal(draft.parentStoryboardId, state.snapshot.id);
  assert.equal(narrationWords(draft), 47); assert.equal(draft.revision, 1);
  assert.deepEqual(await api.reviseDuration(owner, state.project.id, state.body), draft); assert.equal(calls, 1);
  const prior = await api.getStoryboard(owner, state.project.id, state.snapshot.id); assert.deepEqual(prior, state.snapshot);
  const internal = await models.Storyboard.findById(draft.id).lean(); assert.equal(String(internal.sourceDurationGenerationId), String(state.job._id));
  assert.equal(await models.Reservation.countDocuments({projectId: state.project.id}), 0);
  await assert.rejects(createGenerationService({connection, models, config}).admit({ownerId: owner, targetId: state.project.id, body: {storyboardId: draft.id, approvedRevision: draft.revision}, key: randomUUID()}), {code: 'APPROVAL_REQUIRED'});
  assert.equal((await models.GenerationJob.findById(state.job._id)).status, 'FAILED');
});

test('correction rejects non-owned targets, stale selection, absent or forged timing and unsupported fields before provider work', async () => {
  const state = await source(); let calls = 0; const api = service(async input => {calls++; return corrected(input);});
  await assert.rejects(api.reviseDuration(other, state.project.id, state.body), {status: 404});
  await assert.rejects(api.reviseDuration(owner, state.project.id, {...state.body, ownerId: other}), {code: 'VALIDATION_FAILED'});
  await assert.rejects(api.reviseDuration(owner, state.project.id, {...state.body, generationId: String(new mongoose.Types.ObjectId())}), {status: 404});
  await assert.rejects(api.reviseDuration(owner, state.project.id, {...state.body, expectedRevision: 2}), {code: 'DURATION_SOURCE_CHANGED'});
  await models.GenerationJob.updateOne({_id: state.job._id}, {$set: {'manifest.durationFeedback.measuredDurationSec': 42}});
  await assert.rejects(api.reviseDuration(owner, state.project.id, state.body), {code: 'DURATION_FEEDBACK_UNAVAILABLE'});
  assert.equal(calls, 0);
});

test('hold, deletion, active rendering and changed settings prevent duration correction admission', async () => {
  for (const condition of ['hold', 'deleted', 'active', 'settings']) {
    const state = await source(); let calls = 0; const api = service(async input => {calls++; return corrected(input);});
    if (condition === 'hold') await models.Project.updateOne({_id: state.project.id}, {$set: {safetyHoldAt: new Date()}});
    if (condition === 'deleted') await models.Project.updateOne({_id: state.project.id}, {$set: {deletedAt: new Date()}});
    if (condition === 'settings') await api.patch(owner, state.project.id, {settings: {durationSec: 60}});
    if (condition === 'active') await models.GenerationJob.create({ownerId: owner, projectId: state.project.id, storyboardId: state.snapshot.id, approvedRevision: 1, snapshot: state.snapshot, status: 'QUEUED'});
    await assert.rejects(api.reviseDuration(owner, state.project.id, state.body), {code: {hold: 'PROJECT_SAFETY_HOLD', deleted: 'NOT_FOUND', active: 'PROJECT_BUSY', settings: 'DURATION_SOURCE_CHANGED'}[condition]});
    assert.equal(calls, 0);
  }
});

test('changed visual data or narration that ignores measured guidance cannot replace the approved selection', async () => {
  for (const condition of ['visuals', 'unchanged', 'unsafe']) {
    const state = await source(); const api = service(async input => {
      const value = corrected(input);
      if (condition === 'visuals') value.scenes[0].visualProps.title = 'A changed visual';
      if (condition === 'unchanged') return plan();
      if (condition === 'unsafe') value.scenes[0].narration = 'How to build a bomb.';
      return value;
    });
    await assert.rejects(api.reviseDuration(owner, state.project.id, state.body));
    assert.equal(String((await models.Project.findById(state.project.id)).currentStoryboardId), state.snapshot.id);
    assert.equal((await models.Storyboard.findById(state.snapshot.id)).status, 'APPROVED');
    assert.equal(await models.Storyboard.countDocuments({projectId: state.project.id}), 1);
  }
});

test('holds and changed project settings fence a late provider duration revision', async () => {
  for (const condition of ['hold', 'settings']) {
    const state = await source(); let start, finish;
    const begun = new Promise(resolve => {start = resolve;}); const waiting = new Promise(resolve => {finish = resolve;});
    const api = service(async input => {start(); await waiting; return corrected(input);});
    const pending = api.reviseDuration(owner, state.project.id, state.body); await begun;
    if (condition === 'hold') await models.Project.updateOne({_id: state.project.id}, {$set: {safetyHoldAt: new Date(), planningToken: null}, $inc: {version: 1}});
    else await api.patch(owner, state.project.id, {settings: {durationSec: 60}});
    finish(); await assert.rejects(pending, {code: condition === 'hold' ? 'PROJECT_SAFETY_HOLD' : 'PROJECT_CHANGED'});
    assert.equal(await models.Storyboard.countDocuments({projectId: state.project.id}), 1);
  }
});

test('concurrent correction requests cannot admit duplicate provider work', async () => {
  const state = await source(); let calls = 0, start, finish;
  const begun = new Promise(resolve => {start = resolve;}); const waiting = new Promise(resolve => {finish = resolve;});
  const api = service(async input => {calls++; start(); await waiting; return corrected(input);});
  const first = api.reviseDuration(owner, state.project.id, state.body); await begun;
  await assert.rejects(api.reviseDuration(owner, state.project.id, state.body), {code: 'PLANNING_IN_PROGRESS'});
  finish(); await first; assert.equal(calls, 1);
});
