import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {loadConfig} from '../src/config.js';
import {createGenerationService, ensureQueue, transaction} from '../src/jobs/service.js';
import {runWorker} from '../src/jobs/worker.js';
import {hostId} from '../src/jobs/process-control.js';
import {hashApprovedStoryboard} from '../../../packages/video-engine/src/contracts.js';
import {sha256File} from '../../../packages/video-engine/src/media.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => {const value = net.createServer(); value.listen(0, '127.0.0.1', () => {const port = value.address().port; value.close(() => resolve(port));});});
async function until(work) {for (let count = 0; count < 100; count++) {if (await work()) return; await pause(100);} throw new Error('Lifecycle test did not reach its expected state.');}

test('real replica-set admission and lifecycle preserve quotas, replay and cancellation boundaries', {skip: process.platform !== 'win32', timeout: 120000}, async t => {
  const directory = path.join(root, 'var', 'job-db-test-' + randomUUID());
  const port = await freePort();
  const mongo = await startLocalMongo({directory: path.join(directory, 'mongodb'), port, replicaSet: 'avsJobTests'});
  const connections = [];
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8'));
  async function setup() {
    const dbName = 'job_test_' + randomUUID().replaceAll('-', '');
    const uri = `mongodb://127.0.0.1:${port}/${dbName}?replicaSet=avsJobTests`;
    const connection = await mongoose.createConnection(uri).asPromise(); connections.push(connection);
    const models = createStudioModels(connection); await initializeStudioModels(models);
    const ownerId = new mongoose.Types.ObjectId();
    const config = {...loadConfig({MONGODB_URI: uri, JWT_SECRET: 'j'.repeat(40), CSRF_SECRET: 'c'.repeat(40)}), workerWorkRoot: path.join(directory, dbName, 'jobs'), storageRoot: path.join(directory, dbName, 'media'), workerPollMs: 10};
    const service = createGenerationService({connection, config, models});
    await ensureQueue(models);
    async function online() {await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: 'test-worker', workerLeaseToken: 'test-token', workerHeartbeatAt: new Date()}});}
    async function plan() {
      const projectId = new mongoose.Types.ObjectId(), storyboardId = new mongoose.Types.ObjectId();
      const canonical = {...structuredClone(fixture), id: String(storyboardId), projectId: String(projectId), revision: 1};
      await models.Project.create({_id: projectId, ownerId, title: 'A lifecycle test project', prompt: 'A synthetic test topic.', settings: canonical.settingsSnapshot, currentStoryboardId: storyboardId, phase: 'REVIEW'});
      const {_id: ignored, id: ignoredId, projectId: ignoredProject, ...content} = canonical;
      await models.Storyboard.create({...content, _id: storyboardId, projectId, ownerId, contentHash: hashApprovedStoryboard(canonical)});
      return {projectId: String(projectId), body: {storyboardId: String(storyboardId), approvedRevision: 1}};
    }
    return {connection, models, ownerId, config, service, online, plan};
  }
  try {
    await t.test('concurrent same-key replay creates one job and reservation; replay survives worker offline', async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const args = {ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'identical-request-key'};
      const receipts = await Promise.all(Array.from({length: 5}, () => state.service.admit(args)));
      assert.equal(new Set(receipts.map(value => value.receipt.generationId)).size, 1);
      assert.equal(await state.models.GenerationJob.countDocuments(), 1);
      assert.equal(await state.models.Reservation.countDocuments({state: 'RESERVED'}), 1);
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 1);
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null}});
      assert.equal((await state.service.admit(args)).replayed, true);
      const another = await state.plan();
      await assert.rejects(() => state.service.admit({...args, targetId: another.projectId, body: another.body}), {code: 'IDEMPOTENCY_CONFLICT'});
    });
    await t.test('waiting capacity and quota are transactional; queued cancellation settles only once', async () => {
      const state = await setup(); await state.online(); const plans = await Promise.all([state.plan(), state.plan(), state.plan()]);
      const admitted = [];
      for (let index = 0; index < 2; index++) admitted.push(await state.service.admit({ownerId: state.ownerId, targetId: plans[index].projectId, body: plans[index].body, key: 'capacity-key-' + index}));
      await assert.rejects(() => state.service.admit({ownerId: state.ownerId, targetId: plans[2].projectId, body: plans[2].body, key: 'capacity-key-3'}), {code: 'CAPACITY_FULL'});
      const generationId = admitted[0].receipt.generationId;
      const cancelled = await state.service.cancel({ownerId: state.ownerId, generationId});
      assert.equal(cancelled.status, 'CANCELLED');
      await assert.rejects(() => state.service.cancel({ownerId: state.ownerId, generationId}), {code: 'GENERATION_TERMINAL'});
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 1);
      assert.equal((await state.models.QueueState.findById('generation-capacity')).activeCount, 1);
      assert.equal(await state.models.Reservation.countDocuments({state: 'RELEASED'}), 1);
    });
    await t.test('concurrent first admissions on different projects share one UTC bucket without false conflicts', async () => {
      const state = await setup(); await state.online();
      const plans = await Promise.all([state.plan(), state.plan()]);
      const results = await Promise.all(plans.map((plan, index) => state.service.admit({ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'different-project-key-' + index})));
      assert.equal(results.length, 2); assert.equal(await state.models.UsageBucket.countDocuments(), 1);
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 2);
      assert.equal((await state.models.QueueState.findById('generation-capacity')).activeCount, 2);
    });
    await t.test('render failure releases reservation and known duration failure requires a corrected draft', async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const args = {ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'duration-failure-key'};
      const accepted = await state.service.admit(args);
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerLeaseToken: null}});
      const execute = async ({onRegistered}) => {
        await onRegistered('AVS-Render-' + randomUUID().replaceAll('-', ''));
        return {completion: Promise.reject(Object.assign(new Error('Measured mismatch'), {code: 'DURATION_REVISION_REQUIRED'})), stop: async () => {}};
      };
      await runWorker({...state, execute, once: true});
      const job = await state.models.GenerationJob.findById(accepted.receipt.generationId).lean();
      assert.equal(job.status, 'FAILED'); assert.equal(job.error.retryable, false);
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 0);
      assert.equal((await state.models.UsageBucket.findOne()).consumed, 0);
      assert.equal((await state.service.admit(args)).replayed, true);
      await assert.rejects(() => state.service.admit({...args, key: 'new-duration-attempt'}), {code: 'REVISION_REQUIRED'});
    });
    for (const afterHandoff of [false, true]) await t.test(`confirmed cancellation ${afterHandoff ? 'after' : 'before'} render hand-off ${afterHandoff ? 'consumes' : 'releases'} one slot`, async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const accepted = await state.service.admit({ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'cancel-boundary-key'});
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerLeaseToken: null}});
      let rejectCompletion;
      const execute = async ({onRegistered, onProgress}) => {
        await onRegistered('AVS-Render-' + randomUUID().replaceAll('-', ''));
        if (afterHandoff) await onProgress({stage: 'RENDER_VIDEO', event: 'STAGE_STARTED', occurredAt: new Date().toISOString()});
        const completion = new Promise((resolve, reject) => {rejectCompletion = reject;});
        return {completion, stop: async () => rejectCompletion(Object.assign(new Error('Stopped'), {code: 'RENDER_STOPPED'}))};
      };
      const worker = runWorker({...state, execute, once: true});
      await until(async () => {
        const job = await state.models.GenerationJob.findById(accepted.receipt.generationId).lean();
        return job.status === 'PROCESSING' && Boolean(job.execution) && (!afterHandoff || job.renderStartedAt);
      });
      const result = await state.service.cancel({ownerId: state.ownerId, generationId: accepted.receipt.generationId});
      assert.equal(result.status, 'CANCEL_REQUESTED');
      await worker;
      const job = await state.models.GenerationJob.findById(accepted.receipt.generationId).lean();
      const bucket = await state.models.UsageBucket.findOne();
      assert.equal(job.status, 'CANCELLED'); assert.equal(bucket.reserved, 0); assert.equal(bucket.consumed, afterHandoff ? 1 : 0);
      // Fenced repeated settlement cannot settle or charge a terminal job.
      assert.equal(await transaction(state.connection, session => state.service.settle(job, 'FAILED', session, {fencingToken: 'stale'})), null);
    });
    await t.test('expired execution reclaims once with a new fence and preserves render-start settlement evidence', async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const accepted = await state.service.admit({ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'recovery-original-key'});
      const generationId = accepted.receipt.generationId;
      const originalStart = new Date(Date.now() - 120000);
      const staleLease = {workerId: hostId + ':old-worker', fencingToken: 'old-fence', expiresAt: new Date(Date.now() - 1000), heartbeatAt: originalStart};
      await state.models.GenerationJob.updateOne({_id: generationId}, {$set: {status: 'PROCESSING', attempt: 1, stage: 'RENDER_VIDEO', progress: {completedStages: 3, totalStages: 6}, lease: staleLease, renderStartedAt: originalStart, execution: {hostId, controlledJobName: 'AVS-Render-' + randomUUID().replaceAll('-', '')}}});
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerLeaseToken: null, runningJobId: generationId}});
      let rejectCompletion;
      const execute = async ({onRegistered}) => {
        await onRegistered('AVS-Render-' + randomUUID().replaceAll('-', ''));
        return {completion: new Promise((resolve, reject) => {rejectCompletion = reject;}), stop: async () => rejectCompletion(Object.assign(new Error('Stopped'), {code: 'RENDER_STOPPED'}))};
      };
      const worker = runWorker({...state, execute, once: true});
      await until(async () => {const value = await state.models.GenerationJob.findById(generationId).lean(); return value.attempt === 2 && value.execution;});
      const recovered = await state.models.GenerationJob.findById(generationId).lean();
      assert.notEqual(recovered.lease.fencingToken, staleLease.fencingToken);
      assert.equal(recovered.renderStartedAt.toISOString(), originalStart.toISOString());
      assert.equal(recovered.stage, 'PREPARE_ASSETS');
      assert.equal(await state.models.Reservation.countDocuments(), 1, 'Recovery reuses the original reservation');
      assert.equal(await transaction(state.connection, session => state.service.settle(recovered, 'FAILED', session, {fencingToken: 'old-fence'})), null);
      await state.service.cancel({ownerId: state.ownerId, generationId});
      await worker;
      assert.equal((await state.models.GenerationJob.findById(generationId)).status, 'CANCELLED');
      assert.equal((await state.models.UsageBucket.findOne()).consumed, 1, 'Earlier render start still consumes after reclaim');
      await state.online();
      const retry = await state.service.admit({ownerId: state.ownerId, targetId: generationId, body: {}, key: 'manual-retry-new-key', action: 'RETRY'});
      assert.notEqual(retry.receipt.generationId, generationId);
      const next = await state.models.GenerationJob.findById(retry.receipt.generationId);
      assert.equal(next.attempt, 0); assert.equal(String(next.retryOf), generationId);
      assert.equal(await state.models.Reservation.countDocuments(), 2, 'User retry is a fresh admission');
    });
    await t.test('the second expired attempt fails and releases once without launching a third process', async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const accepted = await state.service.admit({ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'exhausted-recovery-key'});
      await state.models.GenerationJob.updateOne({_id: accepted.receipt.generationId}, {$set: {status: 'PROCESSING', attempt: 2, stage: 'SYNTHESIZE_AUDIO', lease: {workerId: hostId + ':old-worker', fencingToken: 'old-second-fence', expiresAt: new Date(Date.now() - 1000), heartbeatAt: new Date(Date.now() - 61000)}}});
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerLeaseToken: null, runningJobId: accepted.receipt.generationId}});
      let called = false;
      await runWorker({...state, execute: async () => {called = true; throw new Error('A third process must never launch');}, once: true});
      assert.equal(called, false);
      const job = await state.models.GenerationJob.findById(accepted.receipt.generationId);
      assert.equal(job.status, 'FAILED'); assert.equal(job.attempt, 2);
      assert.equal(job.error.code, 'WORKER_RECOVERY_EXHAUSTED');
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 0);
      assert.equal((await state.models.QueueState.findById('generation-capacity')).activeCount, 0);
    });
    await t.test('transactional publication commits the private MP4/VTT pair together using an explicit synthetic executor', async () => {
      const state = await setup(); await state.online(); const plan = await state.plan();
      const accepted = await state.service.admit({ownerId: state.ownerId, targetId: plan.projectId, body: plan.body, key: 'publication-pair-key'});
      await state.models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {workerId: null, workerLeaseToken: null}});
      const execute = async ({attemptDirectory, storyboard, onRegistered, onProgress}) => {
        await onRegistered('AVS-Render-' + randomUUID().replaceAll('-', ''));
        await onProgress({stage: 'RENDER_VIDEO', event: 'STAGE_STARTED', occurredAt: new Date().toISOString()});
        const outputDir = path.join(attemptDirectory, 'render'); await fs.mkdir(outputDir, {recursive: true});
        // This tests transactional publication only. These clearly labeled
        // bytes are not claimed to be media, TTS or codec-validation evidence.
        await fs.writeFile(path.join(outputDir, 'video.mp4'), 'SYNTHETIC_PUBLICATION_TRANSACTION_FIXTURE');
        await fs.writeFile(path.join(outputDir, 'captions.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nSynthetic transaction fixture\n');
        const timeline = {schemaVersion: 1, fps: 30, durationInFrames: 900, scenes: storyboard.scenes.map((scene, index) => ({sceneId: scene.sceneId, startFrame: index * 225, durationInFrames: 225, audioAssetId: 'audio_' + scene.sceneId, audioOffsetInFrames: 6, measuredAudioDurationMs: 1000, captionSegments: []}))};
        const manifest = {manifestVersion: 1, generationId: accepted.receipt.generationId, attempt: 1, approvedInput: {storyboardId: storyboard.id, approvedRevision: storyboard.revision, storyboardHash: hashApprovedStoryboard(storyboard)}, provenance: {engineVersion: 'EXPLICIT_SYNTHETIC_EXECUTOR'}, timeline, narrationAssets: timeline.scenes.map(scene => ({sceneId: scene.sceneId, assetId: scene.audioAssetId, sha256: '0'.repeat(64), durationMs: 1000})), captionArtifact: {assetId: 'test_caption', sha256: await sha256File(path.join(outputDir, 'captions.vtt')), mimeType: 'text/vtt', language: 'en', timelineSha256: '0'.repeat(64)}, createdAt: new Date().toISOString()};
        const renderManifestPath = path.join(outputDir, 'render-manifest.json'), publishedManifestPath = path.join(outputDir, 'published-export-manifest.json');
        const write = (file, value) => fs.writeFile(path.join(outputDir, file), JSON.stringify(value));
        await write('storyboard.json', storyboard); await write('render-manifest.json', manifest);
        await write('published-export-manifest.json', {videoArtifact: {sha256: await sha256File(path.join(outputDir, 'video.mp4'))}, captionArtifact: {sha256: manifest.captionArtifact.sha256}});
        await write('preparation.json', {speech: {provider: 'EXPLICIT_SYNTHETIC_EXECUTOR'}});
        await write('result.json', {status: 'COMPLETED', validation: {passed: true, executionMode: 'SYNTHETIC_PUBLICATION_TEST'}, storyboardHash: hashApprovedStoryboard(storyboard), renderManifestPath, publishedManifestPath, timeline, timings: {}});
        return {completion: Promise.resolve({outputDir}), stop: async () => {}};
      };
      await runWorker({...state, execute, once: true});
      const job = await state.models.GenerationJob.findById(accepted.receipt.generationId).lean();
      assert.equal(job.status, 'COMPLETED'); assert.equal(job.progress.completedStages, 6);
      assert.equal(job.manifest.validation.executionMode, 'SYNTHETIC_PUBLICATION_TEST');
      const assets = await state.models.MediaAsset.find({generationId: job._id}).lean();
      assert.equal(assets.length, 2); assert.equal(assets.every(asset => asset.status === 'READY'), true);
      assert.deepEqual(assets.map(asset => asset.kind).sort(), ['CAPTION_TRACK', 'VIDEO_EXPORT']);
      assert.equal(assets[0].expiresAt.toISOString(), assets[1].expiresAt.toISOString());
      assert.equal(assets[0].expiresAt.getTime() - Date.parse(job.manifest.publication.verifiedPublishedAt), 604800000);
      assert.equal((await state.models.UsageBucket.findOne()).reserved, 0);
      assert.equal((await state.models.UsageBucket.findOne()).consumed, 1);
      for (const asset of assets) assert.equal(await sha256File(path.join(state.config.storageRoot, asset.storage.key)), asset.sha256);
    });
  } finally {
    await Promise.all(connections.map(connection => connection.close()));
    await mongo.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(root, 'var') + path.sep));
    await fs.rm(directory, {recursive: true, force: true});
  }
});
