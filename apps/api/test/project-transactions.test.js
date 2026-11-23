import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {createProjectServices} from '../src/projects/index.js';
import {hashApprovedStoryboard} from '../../../packages/video-engine/src/contracts.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.MONGOD_BINARY || 'C:/Program Files/MongoDB/Server/7.0/bin/mongod.exe';
const skip = !existsSync(binary) ? 'Installed mongod is required for real transaction tests.' : false;
const fixture = target => JSON.parse(readFileSync(path.join(root, 'packages/video-engine/fixtures', `event-loop-${target}.json`), 'utf8'));
const plan = target => {const value = fixture(target); return {schemaVersion: 1, targetDurationSec: target, scenes: value.scenes};};
const owner = String(new mongoose.Types.ObjectId());
const other = String(new mongoose.Types.ObjectId());
const projectInput = (title = 'Project transaction test', durationSec = 30) => ({title, prompt: 'Explain the JavaScript event loop.', settings: {...fixture(30).settingsSnapshot, durationSec}});
const config = {geminiTimeoutMs: 1000, planningMaxAttempts: 1};
let mongo, connection, models, service;

before(async () => {
  if (skip) return;
  const port = await new Promise((resolve, reject) => {
    const listener = net.createServer(); listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});
  });
  const directory = path.join(root, 'artifacts/phase4/project-transactions-' + Date.now());
  await fs.mkdir(directory, {recursive: true});
  mongo = await startLocalMongo({directory, port, replicaSet: 'project_transactions', binary});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/project_transactions?replicaSet=project_transactions`, {serverSelectionTimeoutMS: 5000}).asPromise();
  models = createStudioModels(connection);
  await initializeStudioModels(models);
  service = createProjectServices({connection, config, models, planner: async ({settings}) => plan(settings.durationSec)});
});

after(async () => {
  if (connection) await connection.close();
  if (mongo) await mongo.stop();
});

test('real Mongo transactions preserve exact approved snapshots and invalidate changed settings', {skip}, async () => {
  const project = await service.create(owner, projectInput());
  await assert.rejects(service.read(other, project.id), {status: 404});
  const draft = await service.generate(owner, project.id, {});
  assert.equal(draft.status, 'DRAFT'); assert.equal(draft.revision, 1);
  const scenes = structuredClone(draft.scenes); scenes[0].narration += ' Review this idea.';
  const edited = await service.edit(owner, project.id, draft.id, {expectedRevision: 1, scenes});
  assert.equal(edited.revision, 2);
  await assert.rejects(service.edit(owner, project.id, draft.id, {expectedRevision: 1, scenes}), {code: 'REVISION_CONFLICT'});
  const approved = await service.approve(owner, project.id, draft.id, {expectedRevision: 2});
  assert.deepEqual(Object.keys(approved).sort(), ['approvedAt', 'id', 'revision', 'status']);
  assert.equal(approved.status, 'APPROVED'); assert.equal(approved.revision, 2);
  assert.deepEqual(await service.approve(owner, project.id, draft.id, {expectedRevision: 2}), approved);
  const canonical = await service.getStoryboard(owner, project.id, draft.id);
  const stored = await models.Storyboard.findById(draft.id).lean();
  assert.equal(stored.contentHash, hashApprovedStoryboard(canonical));
  await assert.rejects(service.edit(owner, project.id, draft.id, {expectedRevision: 2, scenes}), {code: 'STORYBOARD_IMMUTABLE'});
  const output = new mongoose.Types.ObjectId();
  await models.Project.updateOne({_id: project.id}, {$set: {latestOutputAssetId: output}});
  const titled = await service.patch(owner, project.id, {title: 'Only metadata changed'});
  assert.equal(titled.currentStoryboardId, draft.id);
  assert.equal((await service.getStoryboard(owner, project.id, draft.id)).approvedAt, approved.approvedAt);
  const changed = await service.patch(owner, project.id, {settings: {durationSec: 60}});
  assert.equal(changed.currentStoryboardId, null); assert.equal(changed.phase, 'DRAFT');
  assert.equal(changed.latestOutputAssetId, String(output));
  await assert.rejects(service.getStoryboard(owner, project.id, 'current'), {status: 404});
  assert.deepEqual(await service.getStoryboard(owner, project.id, draft.id), canonical);
  const replacement = await service.generate(owner, project.id, {});
  assert.ok(replacement.id !== draft.id); assert.equal(replacement.targetDurationSec, 60);
  assert.equal(replacement.status, 'DRAFT'); assert.equal(replacement.approvedAt, null);
});

test('real Mongo draft edit/approval race has one valid result without mutable approval', {skip}, async () => {
  const project = await service.create(owner, projectInput('Race test'));
  const draft = await service.generate(owner, project.id, {});
  const scenes = structuredClone(draft.scenes); scenes[0].narration += ' Review this example.';
  const results = await Promise.allSettled([
    service.edit(owner, project.id, draft.id, {expectedRevision: 1, scenes}),
    service.approve(owner, project.id, draft.id, {expectedRevision: 1}),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const saved = await service.getStoryboard(owner, project.id, draft.id);
  assert.ok(saved.status === 'APPROVED' && saved.revision === 1 || saved.status === 'DRAFT' && saved.revision === 2);
  if (saved.status === 'APPROVED') assert.equal((await models.Storyboard.findById(draft.id).lean()).contentHash, hashApprovedStoryboard(saved));
});

test('real Mongo active-job guard prevents destructive changes and deletion revokes new reads', {skip}, async () => {
  const project = await service.create(owner, projectInput('Deletion guard'));
  const draft = await service.generate(owner, project.id, {});
  const approval = await service.approve(owner, project.id, draft.id, {expectedRevision: 1});
  const snapshot = await service.getStoryboard(owner, project.id, draft.id);
  const job = await models.GenerationJob.create({ownerId: owner, projectId: project.id, storyboardId: draft.id, approvedRevision: approval.revision, snapshot, status: 'QUEUED'});
  await assert.rejects(service.patch(owner, project.id, {settings: {durationSec: 60}}), {code: 'PROJECT_BUSY'});
  await assert.rejects(service.remove(owner, project.id), {code: 'PROJECT_BUSY'});
  await assert.rejects(service.generate(owner, project.id, {}), {code: 'PROJECT_BUSY'});
  assert.equal((await service.patch(owner, project.id, {title: 'Metadata still editable'})).title, 'Metadata still editable');
  await models.GenerationJob.updateOne({_id: job._id}, {$set: {status: 'FAILED'}});
  assert.deepEqual(await service.remove(owner, project.id), {projectId: project.id, status: 'DELETION_SCHEDULED'});
  await assert.rejects(service.read(owner, project.id), {status: 404});
  await assert.rejects(service.getStoryboard(owner, project.id, draft.id), {status: 404});
  const deleted = await models.Project.findById(project.id).lean();
  assert.ok(deleted.deletedAt && deleted.cleanupScheduledAt);
});

test('real Mongo planning lease rejects duplicate work and discards stale provider output', {skip}, async () => {
  const project = await service.create(owner, projectInput('Planning lease'));
  let release, started;
  const gate = new Promise(resolve => {release = resolve;});
  const ready = new Promise(resolve => {started = resolve;});
  const delayed = createProjectServices({connection, config, models, planner: async () => {started(); await gate; return plan(30);}});
  const pending = delayed.generate(owner, project.id, {});
  await ready;
  await assert.rejects(service.generate(owner, project.id, {}), {code: 'PLANNING_IN_PROGRESS'});
  await service.patch(owner, project.id, {settings: {durationSec: 60}});
  release();
  await assert.rejects(pending, {code: 'PROJECT_CHANGED'});
  const value = await service.read(owner, project.id);
  assert.equal(value.currentStoryboardId, null); assert.equal(value.settings.durationSec, 60);
  assert.equal(await models.Storyboard.countDocuments({projectId: project.id}), 0);
  assert.equal((await models.Project.findById(project.id).lean()).planningToken, null);
});
