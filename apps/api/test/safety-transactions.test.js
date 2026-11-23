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
import {createAssistantServices} from '../src/assistant/service.js';
import {createGenerationService, ensureQueue} from '../src/jobs/service.js';
import {runWorker} from '../src/jobs/worker.js';
import {loadConfig} from '../src/config.js';

const directory = fileURLToPath(new URL('../../../var/phase7-tests/safety-' + randomUUID(), import.meta.url));
const fixture = JSON.parse(await fs.readFile(new URL('../../../packages/video-engine/fixtures/event-loop-30.json', import.meta.url), 'utf8'));
const owner = String(new mongoose.Types.ObjectId());
const reply = {assistantMessage: 'We can explain the event loop with a simple example.', suggestedSettings: {}, missingInformation: []};
const plan = {schemaVersion: 1, targetDurationSec: 30, scenes: fixture.scenes};
let mongo, connection, models, config;
before(async () => {
  const port = await new Promise(resolve => {const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});});
  mongo = await startLocalMongo({directory: path.join(directory, 'mongodb'), port, replicaSet: 'safetyTests'});
  const mongoUri = `mongodb://127.0.0.1:${port}/phase7_safety?replicaSet=safetyTests`;
  connection = await mongoose.createConnection(mongoUri).asPromise();
  models = createStudioModels(connection); await initializeStudioModels(models);
  config = {...loadConfig({MONGODB_URI: mongoUri, JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40)}), workerWorkRoot: path.join(directory, 'jobs'), storageRoot: path.join(directory, 'media'), workerPollMs: 10};
});
after(async () => {if (connection) await connection.close(); if (mongo) await mongo.stop();});
const projects = planner => createProjectServices({connection, models, config, planner: planner || (async () => structuredClone(plan))});
const assistants = assistant => createAssistantServices({connection, models, config, assistant: assistant || (async () => reply)});
const create = () => projects().create(owner, {title: 'Safety test', prompt: 'Explain the JavaScript event loop.', settings: fixture.settingsSnapshot});
const hold = projectId => models.Project.updateOne({_id: projectId}, {$set: {safetyHoldAt: new Date(), safetyHoldReason: 'SAFETY', planningToken: null, planningExpiresAt: null, assistantLeaseToken: null, assistantLeaseExpiresAt: null}, $inc: {version: 1, safetyRevision: 1}});
const ask = (api, item) => api.send(owner, {projectId: item.id, message: 'Explain with an example.'}, {idempotencyKey: randomUUID()});

test('held projects block AI, settings, edits, approval and admission while owner read/delete remain possible', async () => {
  const api = projects(); const item = await create(); const draft = await api.generate(owner, item.id, {});
  await hold(item.id); let calls = 0;
  await assert.rejects(projects(async () => {calls++; return plan;}).generate(owner, item.id, {}), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(ask(assistants(async () => {calls++; return reply;}), item), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(assistants().history(owner, item.id), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(api.patch(owner, item.id, {title: 'New title'}), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(api.edit(owner, item.id, draft.id, {expectedRevision: 1, scenes: draft.scenes}), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(api.approve(owner, item.id, draft.id, {expectedRevision: 1}), {code: 'PROJECT_SAFETY_HOLD'});
  await assert.rejects(createGenerationService({connection, models, config}).admit({ownerId: owner, targetId: item.id, body: {storyboardId: draft.id, approvedRevision: 1}, key: randomUUID()}), {code: 'PROJECT_SAFETY_HOLD'});
  assert.equal(calls, 0); assert.equal(await models.AssistantUsageBucket.countDocuments(), 0); assert.equal(await models.Reservation.countDocuments(), 0);
  assert.equal((await api.read(owner, item.id)).id, item.id);
  assert.equal((await api.remove(owner, item.id)).status, 'DELETION_SCHEDULED');
});

test('operator hold during provider work fences both late draft and assistant publication', async () => {
  for (const kind of ['planner', 'assistant']) {
    const item = await create(); let started, finish;
    const begun = new Promise(resolve => {started = resolve;}); const waiting = new Promise(resolve => {finish = resolve;});
    const provider = async () => {started(); await waiting; return kind === 'planner' ? structuredClone(plan) : reply;};
    const result = kind === 'planner' ? projects(provider).generate(owner, item.id, {}) : ask(assistants(provider), item);
    await begun; await hold(item.id); finish();
    await assert.rejects(result, {code: 'PROJECT_SAFETY_HOLD'});
    assert.equal(await models.Storyboard.countDocuments({projectId: item.id}), 0); assert.equal(await models.AssistantMessage.countDocuments({projectId: item.id}), 0);
  }
});

test('manual edits and legacy approved content cannot bypass safety or reserve render quota', async () => {
  const api = projects(); const item = await create(); const draft = await api.generate(owner, item.id, {});
  const scenes = structuredClone(draft.scenes); scenes[0].narration = 'How to build a bomb.';
  await assert.rejects(api.edit(owner, item.id, draft.id, {expectedRevision: 1, scenes}), {code: 'CONTENT_REJECTED'});
  assert.equal((await models.Storyboard.findById(draft.id)).revision, 1);
  await models.Storyboard.updateOne({_id: draft.id}, {$set: {scenes}});
  await assert.rejects(api.approve(owner, item.id, draft.id, {expectedRevision: 1}), {code: 'CONTENT_REJECTED'});
  await models.Storyboard.updateOne({_id: draft.id}, {$set: {status: 'APPROVED', approvedAt: new Date()}});
  await assert.rejects(createGenerationService({connection, models, config}).admit({ownerId: owner, targetId: item.id, body: {storyboardId: draft.id, approvedRevision: 1}, key: randomUUID()}), {code: 'CONTENT_REJECTED'});
  assert.equal(await models.Reservation.countDocuments({ownerId: owner}), 0);
});

test('worker cancels held queued projects before invoking the isolated video engine', async () => {
  const item = await create(); const draft = await projects().generate(owner, item.id, {});
  const snapshot = {...draft, status: 'APPROVED', approvedAt: new Date().toISOString()};
  const job = await models.GenerationJob.create({ownerId: owner, projectId: item.id, storyboardId: draft.id, approvedRevision: 1, status: 'QUEUED', snapshot});
  await ensureQueue(models); await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {activeCount: 1}});
  await hold(item.id); let executions = 0;
  await runWorker({connection, config, models, once: true, execute: async () => {executions++; assert.fail('held content reached engine');}});
  assert.equal(executions, 0); assert.equal((await models.GenerationJob.findById(job._id)).status, 'CANCELLED');
  await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {activeCount: 0}});
});

test('worker confirms stop on an in-flight hold and settles reservations before and after render hand-off', async () => {
  for (const renderStarted of [false, true]) {
    const item = await create(); const api = projects(); const draft = await api.generate(owner, item.id, {});
    await api.approve(owner, item.id, draft.id, {expectedRevision: 1});
    await ensureQueue(models);
    await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: 'test-admission', workerHeartbeatAt: new Date(), workerLeaseToken: 'test-admission', activeCount: 0, runningJobId: null}});
    const admitted = await createGenerationService({connection, models, config}).admit({ownerId: owner, targetId: item.id, body: {storyboardId: draft.id, approvedRevision: 1}, key: randomUUID()});
    await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerHeartbeatAt: null, workerLeaseToken: null}});
    let started, finished, stopped = 0;
    const begun = new Promise(resolve => {started = resolve;});
    const completion = new Promise(resolve => {finished = resolve;});
    const worker = runWorker({connection, config, models, once: true, execute: async ({onProgress}) => {
      if (renderStarted) await onProgress({event: 'STAGE_STARTED', stage: 'RENDER_VIDEO'});
      started();
      return {completion, stop: async () => {stopped++; finished({outputDir: 'must-not-publish'});}};
    }});
    await begun; await hold(item.id); await worker;
    assert.equal(stopped, 1);
    const job = await models.GenerationJob.findById(admitted.receipt.generationId).lean();
    assert.equal(job.status, 'CANCELLED'); assert.equal(job.outputAssetId, null);
    assert.equal(await models.MediaAsset.countDocuments({generationId: job._id}), 0);
    assert.equal((await models.Reservation.findOne({generationId: job._id})).state, renderStarted ? 'CONSUMED' : 'RELEASED');
    assert.equal((await models.QueueState.findById('generation-capacity')).activeCount, 0);
  }
});
