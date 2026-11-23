import mongoose from 'mongoose';
import {randomUUID} from 'node:crypto';
import {ApiError} from '../http.js';
import {assertProjectSafetyAvailable, assertStoryboardSafety} from '../safety/index.js';
import {assertVisualQuality} from '../projects/visual-quality.js';
import {canonicalHash, hashApprovedStoryboard, validateStoryboard} from '../../../../packages/video-engine/src/contracts.js';
import {publicStoryboard} from '../projects/validation.js';
import {ACTIVE, QUEUE_ID, admissionReceipt, id, idempotencyKey, missing, objectId, settingsIdentity, strictBody, utcDay} from './contracts.js';

export async function transaction(connection, work) {
  const session = await connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {result = await work(session);}, {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}});
    return result;
  } finally {await session.endSession();}
}

export async function ensureQueue(models) {
  try {await models.QueueState.updateOne({_id: QUEUE_ID}, {$setOnInsert: {activeCount: 0, runningJobId: null, workerId: null, workerHeartbeatAt: null, workerLeaseToken: null}}, {upsert: true});}
  catch (error) {if (error.code !== 11000) throw error;}
}

export function createGenerationService({connection, config, models, now = () => new Date()}) {
  const {Project, Storyboard, GenerationJob, UsageBucket, Reservation, AdmissionReceipt, QueueState} = models;
  async function ownedProject(projectId, ownerId, session) {
    const query = Project.findOne({_id: objectId(projectId), ownerId, deletedAt: null});
    if (session) query.session(session);
    const project = await query.lean();
    if (!project) throw missing();
    return project;
  }
  async function ownedJob(generationId, ownerId, session) {
    const query = GenerationJob.findOne({_id: objectId(generationId), ownerId});
    if (session) query.session(session);
    const job = await query.lean();
    if (!job) throw missing();
    await ownedProject(id(job.projectId), ownerId, session);
    return job;
  }
  async function admit({ownerId, targetId, body, key, action = 'START'}) {
    const keyHash = idempotencyKey(key);
    if (action === 'START') {
      strictBody(body, ['storyboardId', 'approvedRevision']);
      objectId(body.storyboardId);
      if (!Number.isSafeInteger(body.approvedRevision) || body.approvedRevision < 1) throw new ApiError(422, 'VALIDATION_FAILED', 'Select an approved storyboard revision.');
    } else if (body !== undefined) strictBody(body, [], []);
    objectId(targetId);
    const normalizedBody = action === 'START' ? body : {};
    const identityHash = canonicalHash({method: 'POST', routeTemplate: action === 'START' ? '/projects/{projectId}/generations' : '/generations/{generationId}/retry', targetId, body: normalizedBody});
    await ensureQueue(models);
    try {
      return await transaction(connection, async session => {
        const time = now();
        const original = action === 'RETRY' ? await ownedJob(targetId, ownerId, session) : null;
        const project = await ownedProject(action === 'START' ? targetId : id(original.projectId), ownerId, session);
        assertProjectSafetyAvailable(project);
        const receiptFilter = {ownerId, action, keyHash};
        const oldReceipt = await AdmissionReceipt.findOne(receiptFilter).session(session).lean();
        if (oldReceipt && new Date(oldReceipt.expiresAt) > time) {
          if (oldReceipt.identityHash !== identityHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Use a new idempotency key for a different action or request.');
          return {receipt: oldReceipt.receipt, replayed: true};
        }
        if (oldReceipt) await AdmissionReceipt.deleteOne({_id: oldReceipt._id}).session(session);
        if (original && !['FAILED', 'CANCELLED'].includes(original.status)) throw new ApiError(409, 'GENERATION_NOT_RETRYABLE', 'Only a failed or cancelled generation can be retried.');
        if (original?.status === 'FAILED' && !original.error?.retryable) throw new ApiError(409, 'GENERATION_NOT_RETRYABLE', 'Correct the reported issue and approve a new storyboard before generating again.');
        const storyboardId = action === 'START' ? body.storyboardId : id(original.storyboardId);
        const approvedRevision = action === 'START' ? body.approvedRevision : original.approvedRevision;
        const storyboard = await Storyboard.findOne({_id: storyboardId, projectId: project._id, ownerId, status: 'APPROVED', revision: approvedRevision}).session(session).lean();
        if (!storyboard || id(project.currentStoryboardId) !== storyboardId || canonicalHash(settingsIdentity(project.settings)) !== canonicalHash(settingsIdentity(storyboard.settingsSnapshot))) throw new ApiError(409, 'APPROVAL_REQUIRED', 'Review and approve the current storyboard and video settings first.');
        const snapshot = publicStoryboard(storyboard);
        try {validateStoryboard(snapshot);} catch {throw new ApiError(422, 'UNSUPPORTED_STORYBOARD', 'The approved storyboard contains unsupported or invalid content. Review it before rendering.');}
        assertStoryboardSafety(snapshot);
        assertVisualQuality(snapshot);
        const storyboardHash = hashApprovedStoryboard(snapshot);
        if (storyboard.contentHash && storyboard.contentHash !== storyboardHash) throw new ApiError(409, 'APPROVED_INPUT_CHANGED', 'The approved content no longer matches its saved fingerprint.');
        if (await GenerationJob.exists({ownerId, projectId: project._id, storyboardHash, status: 'FAILED', 'error.code': {$in: ['DURATION_REVISION_REQUIRED', 'REVISION_REQUIRED']}}).session(session)) throw new ApiError(409, 'REVISION_REQUIRED', 'Revise the narration and approve a corrected storyboard before generating again.');
        if (await GenerationJob.exists({projectId: project._id, status: {$in: ACTIVE}}).session(session)) throw new ApiError(409, 'GENERATION_ACTIVE', 'This project already has an active generation.');
        const queue = await QueueState.findById(QUEUE_ID).session(session).lean();
        if (!queue?.workerId || !queue.workerHeartbeatAt || time.getTime() - new Date(queue.workerHeartbeatAt).getTime() > 30000) throw new ApiError(503, 'WORKER_OFFLINE', 'The video worker is offline. Your approved storyboard is saved; try again when it is available.', {retryable: true});
        const waiting = await GenerationJob.countDocuments({status: 'QUEUED'}).session(session);
        if (queue.activeCount >= 3 || waiting >= 2) throw new ApiError(429, 'CAPACITY_FULL', 'The video queue is full. Please try again after an active job finishes.', {retryable: true});
        // Acquire the shared admission write before creating a daily bucket, so
        // concurrent first admissions retry on a transaction write conflict
        // instead of racing the unique per-user/day bucket insert.
        const capacity = await QueueState.updateOne({_id: QUEUE_ID, activeCount: {$lt: 3}, workerId: queue.workerId, workerLeaseToken: queue.workerLeaseToken}, {$inc: {activeCount: 1}}).session(session);
        if (capacity.modifiedCount !== 1) throw new ApiError(429, 'CAPACITY_FULL', 'Video capacity changed. Please try again shortly.', {retryable: true});
        const periodStart = utcDay(time);
        const limit = config.dailyGenerationLimit ?? 3;
        let bucket = await UsageBucket.findOne({userId: ownerId, periodStart}).session(session);
        if (!bucket) [bucket] = await UsageBucket.create([{userId: ownerId, periodStart, limit, consumed: 0, reserved: 0}], {session});
        if (bucket.consumed + bucket.reserved >= bucket.limit) throw new ApiError(429, 'DAILY_LIMIT_REACHED', 'Your daily generation allowance is used or reserved. Try after the UTC daily reset.', {retryable: true});
        const generationId = new mongoose.Types.ObjectId();
        const reservationId = new mongoose.Types.ObjectId();
        const job = {_id: generationId, ownerId, projectId: project._id, storyboardId: storyboard._id, approvedRevision, status: 'QUEUED', stage: null, progress: {completedStages: 0, totalStages: 6}, attempt: 0, outputAssetId: null, captionAssetId: null, error: null, snapshot, storyboardHash, settingsHash: canonicalHash(settingsIdentity(snapshot.settingsSnapshot)), retryOf: original?._id ?? null, reservationId, bucketId: bucket._id, lease: null, renderStartedAt: null, cancelRequestedAt: null, execution: null, manifest: {attemptDirectories: [], deliveryVerifiedAt: null}, createdAt: time, updatedAt: time};
        const reserve = await UsageBucket.updateOne({_id: bucket._id, $expr: {$lt: [{$add: ['$consumed', '$reserved']}, '$limit']}}, {$inc: {reserved: 1}}).session(session);
        if (reserve.modifiedCount !== 1) throw new ApiError(429, 'DAILY_LIMIT_REACHED', 'Your daily generation allowance is currently reserved.', {retryable: true});
        await GenerationJob.create([job], {session});
        await Reservation.create([{_id: reservationId, generationId, bucketId: bucket._id, ownerId, amount: 1, unit: 'GENERATION_SLOT', state: 'RESERVED', createdAt: time, updatedAt: time}], {session});
        const receipt = admissionReceipt(job);
        await AdmissionReceipt.create([{ownerId, action, keyHash, identityHash, generationId, receipt, expiresAt: new Date(time.getTime() + 86400000)}], {session});
        const admittedProject = await Project.updateOne({_id: project._id, ownerId, deletedAt: null, safetyHoldAt: null, currentStoryboardId: storyboard._id}, {$set: {phase: 'RENDERING', activeGenerationId: generationId, latestGenerationId: generationId}, $inc: {version: 1}}).session(session);
        if (admittedProject.matchedCount !== 1) throw new ApiError(409, 'PROJECT_CHANGED', 'The project changed before rendering could start. Reload it and review its availability.');
        return {receipt, replayed: false};
      });
    } catch (error) {
      // Unique indexes provide a final fence if concurrent admissions collide.
      if (error.code === 11000) {
        const original = await AdmissionReceipt.findOne({ownerId, action, keyHash, expiresAt: {$gt: now()}}).lean();
        if (original?.identityHash === identityHash) return {receipt: original.receipt, replayed: true};
        if (original) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Use a new idempotency key for this request.');
        throw new ApiError(409, 'GENERATION_ACTIVE', 'Another generation was accepted for this project. Refresh its status before retrying.');
      }
      throw error;
    }
  }
  async function settle(job, terminalStatus, session, {error = null, outputAssetId = null, captionAssetId = null, fencingToken} = {}) {
    const time = now();
    const guard = {_id: job._id, status: {$in: ACTIVE}};
    if (fencingToken) {guard['lease.fencingToken'] = fencingToken; guard['lease.expiresAt'] = {$gt: time};}
    if (terminalStatus === 'COMPLETED') guard.status = 'PROCESSING';
    if (terminalStatus === 'CANCELLED') guard.status = {$in: ['QUEUED', 'CANCEL_REQUESTED']};
    const updated = await GenerationJob.findOneAndUpdate(guard, {$set: {status: terminalStatus, error, outputAssetId, captionAssetId, ...(terminalStatus === 'COMPLETED' ? {stage: 'UPLOAD_OUTPUT', progress: {completedStages: 6, totalStages: 6}} : {}), lease: null, execution: null, updatedAt: time}}, {returnDocument: 'after', session}).lean();
    if (!updated) return null;
    const consume = terminalStatus === 'COMPLETED' || (terminalStatus === 'CANCELLED' && Boolean(updated.renderStartedAt));
    const reservation = await Reservation.findOneAndUpdate({_id: updated.reservationId, generationId: updated._id, state: 'RESERVED'}, {$set: {state: consume ? 'CONSUMED' : 'RELEASED', updatedAt: time}}, {returnDocument: 'after', session}).lean();
    if (reservation) {
      await UsageBucket.updateOne({_id: reservation.bucketId, reserved: {$gte: 1}}, {$inc: {reserved: -1, ...(consume ? {consumed: 1} : {})}}).session(session);
      await QueueState.updateOne({_id: QUEUE_ID, activeCount: {$gte: 1}}, {$inc: {activeCount: -1}}).session(session);
    }
    await QueueState.updateOne({_id: QUEUE_ID, runningJobId: updated._id}, {$set: {runningJobId: null}}).session(session);
    const project = await Project.findById(updated.projectId).session(session).lean();
    if (project) await Project.updateOne({_id: project._id, activeGenerationId: updated._id}, {$set: {activeGenerationId: null, phase: terminalStatus === 'COMPLETED' || project.latestOutputAssetId ? 'HAS_OUTPUT' : 'REVIEW', ...(terminalStatus === 'COMPLETED' ? {latestOutputAssetId: outputAssetId} : {})}}).session(session);
    return updated;
  }
  async function cancel({ownerId, generationId}) {
    return transaction(connection, async session => {
      const job = await ownedJob(generationId, ownerId, session);
      if (!ACTIVE.includes(job.status)) throw new ApiError(409, 'GENERATION_TERMINAL', 'This generation has already finished.');
      if (job.status === 'CANCEL_REQUESTED') return job;
      if (job.status === 'QUEUED' && !job.lease) return settle(job, 'CANCELLED', session);
      return GenerationJob.findOneAndUpdate({_id: job._id, ownerId, status: 'PROCESSING'}, {$set: {status: 'CANCEL_REQUESTED', cancelRequestedAt: now()}}, {returnDocument: 'after', session}).lean();
    });
  }
  return {admit, cancel, settle, ownedJob, ownedProject};
}
