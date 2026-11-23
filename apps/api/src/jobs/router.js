import {Router} from 'express';
import mongoose from 'mongoose';
import {ApiError, sendData} from '../http.js';
import {cancelReceipt, decodeGenerationCursor, emptyBody, encodeGenerationCursor, publicGeneration} from './contracts.js';
import {createGenerationService} from './service.js';
import {trustedDurationFeedback} from '../projects/duration-feedback.js';
import {assertProjectSafetyAvailable} from '../safety/index.js';

export function buildGenerationRouter({connection, config, models}) {
  const router = Router();
  const service = createGenerationService({connection, config, models});
  router.post('/projects/:projectId/generations', async (req, res) => {
    const result = await service.admit({ownerId: req.auth.userId, targetId: req.params.projectId, body: req.body, key: req.get('Idempotency-Key')});
    return sendData(req, res, result.receipt, 202);
  });
  router.get('/generations/:generationId', async (req, res) => {
    if (Object.keys(req.query).length) throw new ApiError(400, 'INVALID_QUERY', 'Generation polling does not accept query parameters.');
    const job = await service.ownedJob(req.params.generationId, req.auth.userId);
    res.set('Retry-After', '3');
    return sendData(req, res, publicGeneration(job));
  });
  router.get('/generations/:generationId/narration-feedback', async (req, res) => {
    if (Object.keys(req.query).length) throw new ApiError(400, 'INVALID_QUERY', 'Narration timing does not accept query parameters.');
    const job = await service.ownedJob(req.params.generationId, req.auth.userId);
    const project = await service.ownedProject(String(job.projectId), req.auth.userId);
    assertProjectSafetyAvailable(project);
    const feedback = trustedDurationFeedback(job);
    if (!feedback) return sendData(req, res, {available: false});
    const selected = project.currentStoryboardId ? await models.Storyboard.findOne({_id: project.currentStoryboardId, ownerId: req.auth.userId, projectId: project._id, status: 'DRAFT', sourceDurationGenerationId: job._id, parentStoryboardId: job.storyboardId}).lean() : null;
    return sendData(req, res, {available: true, generationId: String(job._id), projectId: String(job.projectId), storyboardId: String(job.storyboardId), approvedRevision: job.approvedRevision, targetDurationSec: feedback.targetDurationSec, measuredDurationSec: feedback.measuredDurationSec, narrationWords: feedback.narrationWords, sceneCount: feedback.sceneCount, suggestedNarrationWords: feedback.suggestedNarrationWords, direction: feedback.direction, correctedStoryboardId: selected ? String(selected._id) : null});
  });
  router.get('/projects/:projectId/generations', async (req, res) => {
    const project = await service.ownedProject(req.params.projectId, req.auth.userId);
    if (Object.keys(req.query).some(key => !['limit', 'cursor'].includes(key)) || (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9]\d?$/u.test(req.query.limit) || Number(req.query.limit) > 50))) throw new ApiError(400, 'INVALID_QUERY', 'Choose a limit from 1 to 50.');
    const limit = Number(req.query.limit || 20);
    const filter = {ownerId: req.auth.userId, projectId: project._id};
    if (req.query.cursor !== undefined) {
      const cursor = decodeGenerationCursor(req.query.cursor, req.auth.userId, project._id, config.csrfSecret);
      filter.$or = [{createdAt: {$lt: cursor.createdAt}}, {createdAt: cursor.createdAt, _id: {$lt: new mongoose.Types.ObjectId(cursor.id)}}];
    }
    const records = await models.GenerationJob.find(filter).sort({createdAt: -1, _id: -1}).limit(limit + 1).lean();
    const page = records.slice(0, limit);
    return sendData(req, res, {generations: page.map(publicGeneration), nextCursor: records.length > limit ? encodeGenerationCursor(page.at(-1), req.auth.userId, config.csrfSecret) : null});
  });
  router.post('/generations/:generationId/cancel', async (req, res) => {
    emptyBody(req.body);
    return sendData(req, res, cancelReceipt(await service.cancel({ownerId: req.auth.userId, generationId: req.params.generationId})), 202);
  });
  router.post('/generations/:generationId/retry', async (req, res) => {
    const result = await service.admit({ownerId: req.auth.userId, targetId: req.params.generationId, action: 'RETRY', body: req.body, key: req.get('Idempotency-Key')});
    return sendData(req, res, result.receipt, 202);
  });
  return router;
}
