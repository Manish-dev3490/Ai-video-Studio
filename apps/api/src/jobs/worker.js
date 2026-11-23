import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {canonicalHash, hashApprovedStoryboard, validateStoryboard} from '../../../../packages/video-engine/src/contracts.js';
import {readJson, sha256File} from '../../../../packages/video-engine/src/media.js';
import {assertStoryboardSafety} from '../safety/index.js';
import {assertVisualQuality} from '../projects/visual-quality.js';
import {sanitizeDurationEvidence} from '../projects/duration-feedback.js';
import {ACTIVE, QUEUE_ID, STAGES, id} from './contracts.js';
import {createGenerationService, ensureQueue, transaction} from './service.js';
import {acquireWorkerLock, configureProcessControl, hostId, startControlledRender, stopControlledJob} from './process-control.js';
import {copyOwnedExport, ensureDirectoryUnder, removeOwnedCopy} from './files.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (root, value) => {const relative = path.relative(root, value); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));};
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
async function safePrivateRoot(value) {
  const allowed = path.join(repositoryRoot, 'var');
  const requested = path.resolve(value);
  if (!within(allowed, requested) || requested === allowed) throw new Error('INVALID_WORKER_DIRECTORY');
  let ancestor = requested;
  const missing = [];
  for (;;) {
    try {ancestor = await fs.realpath(ancestor); break;} catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {await fs.lstat(ancestor); throw new Error('INVALID_WORKER_DIRECTORY');} catch (failure) {if (failure.code !== 'ENOENT') throw failure;}
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  const resolved = path.join(ancestor, ...missing);
  if (!within(allowed, resolved)) throw new Error('INVALID_WORKER_DIRECTORY');
  await fs.mkdir(resolved, {recursive: true});
  return resolved;
}
const failureFor = code => {
  if (code === 'LAYOUT_REVIEW_REQUIRED') return {code, message: 'This diagram needs a simpler layout. Review a new draft with a short forward flow or use a steps scene.', retryable: false};
  if (['DURATION_REVISION_REQUIRED', 'REVISION_REQUIRED'].includes(code)) return {code: 'DURATION_REVISION_REQUIRED', message: 'The measured narration does not fit the selected length. Revise the script and approve a new storyboard.', retryable: false};
  if (['CONTENT_REJECTED', 'SENSITIVE_INPUT'].includes(code)) return {code, message: 'The approved content did not pass the safety checks. Revise and approve a safe storyboard before generating again.', retryable: false};
  if (['INVALID_STORYBOARD', 'UNSUPPORTED_TEMPLATE', 'STORYBOARD_NOT_APPROVED', 'INVALID_TIMELINE'].includes(code)) return {code, message: 'Review and correct the storyboard before generating again.', retryable: false};
  return {code: /^[A-Z0-9_]{1,80}$/u.test(code || '') ? code : 'RENDER_FAILED', message: code === 'STAGE_TIMEOUT' ? 'A video generation stage exceeded its local time limit. Your approved storyboard is saved; you can retry.' : 'The video could not be completed. Your approved storyboard is saved; you can retry when the worker is ready.', retryable: true};
};
const defaultTimeout = (duration, stage) => ({PREPARE_ASSETS: 60000, SYNTHESIZE_AUDIO: {30: 480000, 60: 900000, 90: 1200000}[duration], ALIGN_TIMELINE: 60000, RENDER_VIDEO: {30: 480000, 60: 900000, 90: 1200000}[duration], VALIDATE_OUTPUT: 120000, UPLOAD_OUTPUT: 60000}[stage] || 120000);

export async function cleanupWorkerArtifacts({models, config, now = new Date()}) {
  const root = await safePrivateRoot(config.workerWorkRoot);
  const candidates = await models.GenerationJob.find({status: {$in: ['COMPLETED', 'FAILED', 'CANCELLED']}, 'manifest.attemptDirectories.0': {$exists: true}}).select('status projectId completedAt updatedAt manifest').lean();
  for (const job of candidates) {
    if (job.manifest.cleanupCompletedAt) continue;
    const projectLive = await models.Project.exists({_id: job.projectId, deletedAt: null});
    const publicationTime = new Date(job.completedAt || job.manifest.publication?.verifiedPublishedAt || job.updatedAt).getTime();
    const explicitExpiry = new Date(job.manifest.publication?.expiresAt || publicationTime + 604800000).getTime();
    const exportExpired = now.getTime() >= Math.min(explicitExpiry, publicationTime + 604800000);
    if (projectLive && (job.status === 'COMPLETED' ? !job.manifest.deliveryVerifiedAt && !exportExpired : now.getTime() - new Date(job.updatedAt).getTime() < 86400000)) continue;
    for (const directory of job.manifest.attemptDirectories) {
      const absolute = path.resolve(directory);
      if (!within(root, absolute) || absolute === root || !path.basename(absolute).match(/^attempt-[12]-[a-f0-9]{32}$/u)) throw new Error('INVALID_CLEANUP_DIRECTORY');
      try {
        const real = await fs.realpath(absolute);
        if (!within(root, real)) throw new Error('INVALID_CLEANUP_DIRECTORY');
        await fs.rm(real, {recursive: true, force: true});
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    await models.GenerationJob.updateOne({_id: job._id, status: job.status}, {$set: {'manifest.cleanupCompletedAt': now}});
  }
}

export async function runWorker({connection, config, models, signal, onEvent = () => {}, execute = startControlledRender, once = false, maintenance = async () => {}}) {
  configureProcessControl(config);
  const workRoot = await safePrivateRoot(config.workerWorkRoot);
  const storageRoot = await safePrivateRoot(config.storageRoot);
  // Explicit dependency injection is used only by lifecycle tests. The actual
  // worker entry point always uses startControlledRender and verifies assets.
  if (execute === startControlledRender) {
    await fs.access(config.browserExecutable);
    const {verifyKokoroSetup, DEFAULT_MODEL_PATH} = await import(pathToFileURL(path.join(config.engineRoot, 'scripts/setup-kokoro.js')).href);
    await verifyKokoroSetup(config.kokoroModelPath || DEFAULT_MODEL_PATH);
  }
  const lock = await acquireWorkerLock(workRoot);
  const workerId = lock.state.workerId;
  const workerToken = randomUUID();
  const leaseMs = config.workerLeaseMs || 60000;
  const heartbeatMs = config.workerHeartbeatMs || 10000;
  const pollMs = config.workerPollMs || 1000;
  const service = createGenerationService({connection, config, models});
  const {GenerationJob, QueueState, Project, MediaAsset} = models;
  let registered = false;
  let lastMaintenance = 0;
  await ensureQueue(models);

  const fenced = (job, statuses = ['PROCESSING', 'CANCEL_REQUESTED']) => ({_id: job._id, status: {$in: statuses}, 'lease.fencingToken': job.lease.fencingToken, 'lease.expiresAt': {$gt: new Date()}});
  async function heartbeat() {
    const result = await QueueState.updateOne({_id: QUEUE_ID, workerId, workerLeaseToken: workerToken}, {$set: {workerHeartbeatAt: new Date()}});
    if (result.matchedCount !== 1) throw Object.assign(new Error('Worker registration was lost.'), {code: 'LEASE_LOST'});
  }
  async function register() {
    const queue = await QueueState.findById(QUEUE_ID).lean();
    if (queue.workerId && queue.workerId !== workerId) {
      if (queue.workerId !== lock.recoveredWorkerId && queue.workerHeartbeatAt && Date.now() - new Date(queue.workerHeartbeatAt).getTime() < 30000) throw new Error('WORKER_ALREADY_REGISTERED');
      if (!queue.workerId.startsWith(hostId + ':')) throw new Error('FOREIGN_WORKER_STOP_UNCONFIRMED');
    }
    const result = await QueueState.updateOne({_id: QUEUE_ID, workerLeaseToken: queue.workerLeaseToken ?? null}, {$set: {workerId, workerHeartbeatAt: new Date(), workerLeaseToken: workerToken}});
    if (result.matchedCount !== 1) throw new Error('WORKER_REGISTRATION_RACE');
    registered = true;
  }
  async function claim() {
    return transaction(connection, async session => {
      const queue = await QueueState.findOneAndUpdate({_id: QUEUE_ID, workerId, workerLeaseToken: workerToken, runningJobId: null}, {$set: {workerHeartbeatAt: new Date()}}, {returnDocument: 'after', session}).lean();
      if (!queue) return null;
      const candidate = await GenerationJob.findOne({status: 'QUEUED', attempt: 0}).sort({createdAt: 1, _id: 1}).session(session).lean();
      if (!candidate) return null;
      const project = await Project.findOne({_id: candidate.projectId, ownerId: candidate.ownerId, deletedAt: null, safetyHoldAt: null}).session(session).lean();
      if (!project) {
        await service.settle(candidate, 'CANCELLED', session);
        return null;
      }
      const time = new Date();
      const lease = {workerId, fencingToken: randomUUID(), expiresAt: new Date(time.getTime() + leaseMs), heartbeatAt: time};
      const job = await GenerationJob.findOneAndUpdate({_id: candidate._id, status: 'QUEUED', attempt: 0}, {$set: {status: 'PROCESSING', stage: 'PREPARE_ASSETS', progress: {completedStages: 0, totalStages: 6}, lease}, $inc: {attempt: 1}}, {returnDocument: 'after', session}).lean();
      if (!job) return null;
      await QueueState.updateOne({_id: QUEUE_ID, workerLeaseToken: workerToken, runningJobId: null}, {$set: {runningJobId: job._id}}).session(session);
      return job;
    });
  }
  async function recover() {
    const expired = await GenerationJob.findOne({status: {$in: ['PROCESSING', 'CANCEL_REQUESTED']}, 'lease.expiresAt': {$lte: new Date()}}).sort({createdAt: 1}).lean();
    if (!expired) return null;
    if (expired.execution?.hostId && expired.execution.hostId !== hostId) throw new Error('FOREIGN_EXECUTION_STOP_UNCONFIRMED');
    if (expired.execution?.controlledJobName) await stopControlledJob(expired.execution.controlledJobName);
    return transaction(connection, async session => {
      const current = await GenerationJob.findOne({_id: expired._id, status: {$in: ['PROCESSING', 'CANCEL_REQUESTED']}, 'lease.fencingToken': expired.lease.fencingToken, 'lease.expiresAt': {$lte: new Date()}}).session(session).lean();
      if (!current) return null;
      const time = new Date();
      const lease = {workerId, fencingToken: randomUUID(), expiresAt: new Date(time.getTime() + leaseMs), heartbeatAt: time};
      const updated = await GenerationJob.findOneAndUpdate({_id: current._id, 'lease.fencingToken': current.lease.fencingToken, status: current.status}, {$set: {lease, execution: null}}, {returnDocument: 'after', session}).lean();
      const project = await Project.findOne({_id: current.projectId, deletedAt: null, safetyHoldAt: null}).session(session).lean();
      if (current.status === 'CANCEL_REQUESTED' || !project) {
        if (updated.status !== 'CANCEL_REQUESTED') {updated.status = 'CANCEL_REQUESTED'; await GenerationJob.updateOne({_id: updated._id, 'lease.fencingToken': lease.fencingToken}, {$set: {status: 'CANCEL_REQUESTED', cancelRequestedAt: time}}).session(session);}
        await service.settle(updated, 'CANCELLED', session, {fencingToken: lease.fencingToken});
        return null;
      }
      if (current.attempt >= (config.maxExecutionAttempts || 2)) {
        await service.settle(updated, 'FAILED', session, {fencingToken: lease.fencingToken, error: failureFor('WORKER_RECOVERY_EXHAUSTED')});
        return null;
      }
      const job = await GenerationJob.findOneAndUpdate({_id: updated._id, status: 'PROCESSING', 'lease.fencingToken': lease.fencingToken}, {$inc: {attempt: 1}, $set: {stage: 'PREPARE_ASSETS', progress: {completedStages: 0, totalStages: 6}}}, {returnDocument: 'after', session}).lean();
      await QueueState.updateOne({_id: QUEUE_ID, workerLeaseToken: workerToken}, {$set: {runningJobId: job._id}}).session(session);
      return job;
    });
  }
  async function publish(job, outputDir, attemptDirectory) {
    const expected = path.resolve(attemptDirectory, 'render');
    if (path.resolve(outputDir) !== expected) throw new Error('ARTIFACT_INTEGRITY_FAILED');
    const result = await readJson(path.join(expected, 'result.json'));
    const input = await readJson(path.join(expected, 'storyboard.json'));
    if (result.status !== 'COMPLETED' || !result.validation?.passed || result.storyboardHash !== job.storyboardHash || hashApprovedStoryboard(input) !== job.storyboardHash) throw new Error('ARTIFACT_INTEGRITY_FAILED');
    if (!within(expected, path.resolve(result.renderManifestPath)) || !within(expected, path.resolve(result.publishedManifestPath))) throw new Error('ARTIFACT_INTEGRITY_FAILED');
    const originalManifest = await readJson(result.renderManifestPath);
    const originalPublication = await readJson(result.publishedManifestPath);
    const videoId = new mongoose.Types.ObjectId(), captionId = new mongoose.Types.ObjectId();
    const exportDirectory = path.join(storageRoot, 'exports', id(job._id));
    await ensureDirectoryUnder(storageRoot, exportDirectory);
    const files = [
      {assetId: videoId, source: path.join(expected, 'video.mp4'), key: `exports/${id(job._id)}/${id(videoId)}.mp4`, kind: 'VIDEO_EXPORT', mimeType: 'video/mp4', expectedHash: originalPublication.videoArtifact.sha256},
      {assetId: captionId, source: path.join(expected, 'captions.vtt'), key: `exports/${id(job._id)}/${id(captionId)}.vtt`, kind: 'CAPTION_TRACK', mimeType: 'text/vtt', expectedHash: originalPublication.captionArtifact.sha256},
    ];
    try {
    for (const file of files) {
      const stat = await fs.lstat(file.source);
      if (!stat.isFile() || stat.isSymbolicLink() || !within(expected, await fs.realpath(file.source))) throw new Error('ARTIFACT_INTEGRITY_FAILED');
      file.destination = path.join(storageRoot, file.key);
      await copyOwnedExport(file, storageRoot);
      file.sha256 = await sha256File(file.destination);
      file.byteSize = (await fs.stat(file.destination)).size;
      if (file.sha256 !== file.expectedHash) throw new Error('ARTIFACT_INTEGRITY_FAILED');
    }
      return await transaction(connection, async session => {
        const current = await GenerationJob.findOne(fenced(job, ['PROCESSING'])).session(session).lean();
        const project = await Project.findOne({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null, activeGenerationId: job._id}).session(session).lean();
        if (!current || !project) throw Object.assign(new Error('Completion lost its guarded state.'), {code: 'PUBLICATION_NOT_ALLOWED'});
        const publishedAt = new Date();
        const expiresAt = new Date(publishedAt.getTime() + 604800000);
        const timeline = structuredClone(originalManifest.timeline);
        const mapping = new Map(timeline.scenes.map(scene => [scene.audioAssetId, `${id(job._id)}_audio_${canonicalHash(scene.sceneId).slice(0, 24)}`]));
        for (const scene of timeline.scenes) scene.audioAssetId = mapping.get(scene.audioAssetId);
        const captionArtifact = {...originalManifest.captionArtifact, assetId: id(captionId), timelineSha256: canonicalHash(timeline)};
        const renderManifest = {...originalManifest, generationId: id(job._id), attempt: job.attempt, timeline, narrationAssets: originalManifest.narrationAssets.map(asset => ({...asset, assetId: mapping.get(asset.assetId)})), captionArtifact};
        const publication = {manifestVersion: 1, generationId: id(job._id), attempt: job.attempt, renderManifestSha256: canonicalHash(renderManifest), videoArtifact: {assetId: id(videoId), sha256: files[0].sha256, mimeType: 'video/mp4'}, captionArtifact, verifiedPublishedAt: publishedAt.toISOString(), expiresAt: expiresAt.toISOString()};
        await MediaAsset.create(files.map(file => ({_id: file.assetId, ownerId: job.ownerId, projectId: job.projectId, generationId: job._id, kind: file.kind, status: 'READY', mimeType: file.mimeType, byteSize: file.byteSize, sha256: file.sha256, storage: {provider: 'LOCAL', key: file.key}, aiGenerated: true, metadata: {width: 1280, height: 720, fps: 30, durationSec: result.timeline.durationInFrames / 30, language: job.snapshot.settingsSnapshot.language}, expiresAt, deletedAt: null})), {session, ordered: true});
        const manifest = {...current.manifest, render: renderManifest, publication, engineRenderManifestHash: canonicalHash(originalManifest), enginePublicationManifestHash: canonicalHash(originalPublication), validation: result.validation, timings: result.timings, speech: (await readJson(path.join(expected, 'preparation.json'))).speech, deliveryVerifiedAt: null};
        await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {manifest, completedAt: publishedAt}}).session(session);
        const terminal = await service.settle(current, 'COMPLETED', session, {fencingToken: job.lease.fencingToken, outputAssetId: videoId, captionAssetId: captionId});
        if (!terminal) throw new Error('PUBLICATION_NOT_ALLOWED');
        return terminal;
      });
    } catch (error) {
      for (const file of files) await removeOwnedCopy(file, storageRoot).catch(() => {});
      throw error;
    }
  }

  async function executeJob(job) {
    const attemptDirectory = path.join(workRoot, id(job._id), `attempt-${job.attempt}-${randomUUID().replaceAll('-', '')}`);
    let stage = 'PREPARE_ASSETS', stageStartedAt = Date.now();
    let controlled, finished = false, stopReason, executionFailure, result;
    let processStopped = false, lastLeaseHeartbeat = 0;
    const onProgress = async event => {
      if (!STAGES.includes(event.stage)) return;
      if (event.stage === 'RENDER_VIDEO' && event.event === 'STAGE_STARTED') {
        // The renderer is owned and parked at a native-process execution gate.
        // Serialize the live-project/cancellation check, stage entry and durable
        // hand-off record before permitting the render call to proceed.
        await transaction(connection, async session => {
          const current = await GenerationJob.findOne(fenced(job, ['PROCESSING'])).session(session).lean();
          if (!current) throw Object.assign(new Error('The render hand-off was cancelled.'), {code: 'CANCEL_REQUESTED'});
          const project = await Project.updateOne({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null, activeGenerationId: job._id}, {$inc: {version: 1}}).session(session);
          if (project.matchedCount !== 1) throw Object.assign(new Error('The project is no longer renderable.'), {code: 'CANCEL_REQUESTED'});
          const time = new Date();
          const update = await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {stage: 'RENDER_VIDEO', progress: {completedStages: 3, totalStages: 6}, ...(current.renderStartedAt ? {} : {renderStartedAt: time}), 'manifest.renderExecutionHandoffAt': time}}).session(session);
          if (update.matchedCount !== 1) throw Object.assign(new Error('The render hand-off lease was lost.'), {code: 'LEASE_LOST'});
        });
        stage = 'RENDER_VIDEO'; stageStartedAt = Date.now();
        return;
      }
      const current = await GenerationJob.findOne(fenced(job)).lean();
      if (!current) throw Object.assign(new Error('Lease was lost.'), {code: 'LEASE_LOST'});
      if (event.event === 'RENDER_PROGRESS' && event.stage === 'RENDER_VIDEO' && !current.manifest?.firstRenderedFrameAt) {
        const startedAt = new Date(event.occurredAt);
        if (Number.isFinite(startedAt.getTime()) && startedAt.getTime() <= Date.now() + 1000 && startedAt.getTime() >= stageStartedAt - 1000 && (!current.cancelRequestedAt || startedAt <= current.cancelRequestedAt)) await GenerationJob.updateOne({...fenced(job), 'manifest.firstRenderedFrameAt': {$exists: false}}, {$set: {'manifest.firstRenderedFrameAt': startedAt}});
      }
      if (current.status !== 'PROCESSING') throw Object.assign(new Error('Cancellation is pending.'), {code: 'CANCEL_REQUESTED'});
      const projectLive = await Project.exists({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null});
      if (!projectLive) throw Object.assign(new Error('Project was removed.'), {code: 'CANCEL_REQUESTED'});
      const index = STAGES.indexOf(event.stage);
      const completed = event.event === 'STAGE_COMPLETED' ? Math.min(5, index + 1) : index;
      if (index >= STAGES.indexOf(stage)) {
        if (event.stage !== stage) {stage = event.stage; stageStartedAt = Date.now();}
        const update = await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {stage: event.stage, progress: {completedStages: Math.max(current.progress.completedStages, completed), totalStages: 6}}});
        if (update.matchedCount !== 1) throw Object.assign(new Error('Lease was lost.'), {code: 'LEASE_LOST'});
      }
    };
    try {
      validateStoryboard(job.snapshot);
      assertStoryboardSafety(job.snapshot);
      assertVisualQuality(job.snapshot);
      if (!await Project.exists({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null})) throw Object.assign(new Error('Project is no longer renderable.'), {code: 'CANCEL_REQUESTED'});
      if (hashApprovedStoryboard(job.snapshot) !== job.storyboardHash) throw new Error('ARTIFACT_INTEGRITY_FAILED');
      if (!job.manifest) await GenerationJob.updateOne({...fenced(job, ['PROCESSING']), manifest: null}, {$set: {manifest: {attemptDirectories: [], deliveryVerifiedAt: null}}});
      controlled = await execute({attemptDirectory, config, storyboard: job.snapshot, onProgress, parentStartIdentity: lock.state.startIdentity, onRegistered: async controlledJobName => {
        await lock.setExecution(controlledJobName);
        const recorded = await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {execution: {hostId, controlledJobName, attemptDirectory, startedAt: new Date()}, 'manifest.lastAttemptDirectory': attemptDirectory}, $addToSet: {'manifest.attemptDirectories': attemptDirectory}});
        if (recorded.matchedCount !== 1) throw Object.assign(new Error('The execution lease was lost.'), {code: 'LEASE_LOST'});
      }});
      const monitor = (async () => {
        while (!finished) {
          await pause(500);
          if (finished) break;
          try {
            const current = await GenerationJob.findOne(fenced(job)).lean();
            if (!current) stopReason = 'LEASE_LOST';
            else if (current.status === 'CANCEL_REQUESTED' || !await Project.exists({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null})) {
              stopReason = 'CANCEL_REQUESTED';
              await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date()}});
            } else if (signal?.aborted) stopReason = 'WORKER_SHUTDOWN';
            else if (Date.now() - stageStartedAt > (config.workerStageTimeoutMs?.[job.snapshot.targetDurationSec]?.[stage] || defaultTimeout(job.snapshot.targetDurationSec, stage))) stopReason = 'STAGE_TIMEOUT';
            if (stopReason) {await controlled.stop(); processStopped = true; return;}
            if (Date.now() - lastLeaseHeartbeat >= heartbeatMs) {
              const time = new Date();
              const heartbeatResult = await GenerationJob.updateOne(fenced(job), {$set: {'lease.expiresAt': new Date(time.getTime() + leaseMs), 'lease.heartbeatAt': time}});
              if (heartbeatResult.matchedCount !== 1) throw new Error('Lease heartbeat was rejected.');
              await heartbeat(); lastLeaseHeartbeat = Date.now();
            }
          } catch {
            stopReason ||= 'LEASE_LOST';
            await controlled.stop(); processStopped = true; return;
          }
        }
      })();
      monitor.catch(() => {});
      try {result = await controlled.completion; processStopped = true;} catch (error) {executionFailure = error;}
      finally {finished = true; await monitor;}
      if (!processStopped) {await controlled.stop(); processStopped = true;}
      if (stopReason === 'LEASE_LOST') return;
      const current = await GenerationJob.findOne(fenced(job)).lean();
      if (!current) return;
      if (stopReason === 'WORKER_SHUTDOWN') {
        await GenerationJob.updateOne(fenced(job), {$set: {'lease.expiresAt': new Date()}});
        return;
      }
      if (current.status === 'CANCEL_REQUESTED' || stopReason === 'CANCEL_REQUESTED') {
        await transaction(connection, session => service.settle(current, 'CANCELLED', session, {fencingToken: job.lease.fencingToken}));
        return;
      }
      if (stopReason === 'STAGE_TIMEOUT') throw Object.assign(new Error('Stage timed out.'), {code: 'STAGE_TIMEOUT'});
      if (executionFailure) throw executionFailure;
      stage = 'UPLOAD_OUTPUT'; stageStartedAt = Date.now();
      await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {stage, progress: {completedStages: 5, totalStages: 6}}});
      await publish(job, result.outputDir, attemptDirectory);
      onEvent({event: 'GENERATION_COMPLETED', generationId: id(job._id), attempt: job.attempt});
    } catch (error) {
      if (controlled && !processStopped) {await controlled.stop(); processStopped = true;}
      let current = await GenerationJob.findOne(fenced(job)).lean();
      if (!current) return;
      const projectAvailable = await Project.exists({_id: job.projectId, ownerId: job.ownerId, deletedAt: null, safetyHoldAt: null});
      if ((error.code === 'CANCEL_REQUESTED' || !projectAvailable) && current.status === 'PROCESSING') current = await GenerationJob.findOneAndUpdate(fenced(job, ['PROCESSING']), {$set: {status: 'CANCEL_REQUESTED', cancelRequestedAt: new Date()}}, {returnDocument: 'after'}).lean() || current;
      if (controlled && !processStopped) throw Object.assign(new Error('Owned process state remains unknown.'), {code: 'PROCESS_STOP_UNCONFIRMED'});
      const durationFeedback = error.code === 'DURATION_REVISION_REQUIRED' && current.status !== 'CANCEL_REQUESTED' ? sanitizeDurationEvidence(error.durationFeedback, job.snapshot) : null;
      await transaction(connection, async session => {
        if (durationFeedback) await GenerationJob.updateOne(fenced(job, ['PROCESSING']), {$set: {'manifest.durationFeedback': durationFeedback}}).session(session);
        return service.settle(current, current.status === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'FAILED', session, {fencingToken: job.lease.fencingToken, error: current.status === 'CANCEL_REQUESTED' ? null : failureFor(error.code || error.message)});
      });
      onEvent({event: 'GENERATION_FINISHED', generationId: id(job._id), status: current.status === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'FAILED'});
    } finally {
      if (processStopped || !controlled) await lock.setExecution(null);
    }
  }

  try {
    await register();
    onEvent({event: 'WORKER_ONLINE', workerId});
    while (!signal?.aborted) {
      await heartbeat();
      const job = await recover() || await claim();
      if (job) {
        onEvent({event: 'GENERATION_STARTED', generationId: id(job._id), attempt: job.attempt});
        await executeJob(job);
      } else await pause(pollMs);
      if (Date.now() - lastMaintenance > 30000) {await cleanupWorkerArtifacts({models, config}); await maintenance(); lastMaintenance = Date.now();}
      if (once) break;
    }
  } finally {
    if (registered) await QueueState.updateOne({_id: QUEUE_ID, workerId, workerLeaseToken: workerToken}, {$set: {workerId: null, workerHeartbeatAt: null, workerLeaseToken: null}}).catch(() => {});
    await lock.release();
  }
}
