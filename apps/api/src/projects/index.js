import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import mongoose from 'mongoose';
import {ApiError, sendData} from '../http.js';
import {canonicalHash, hashApprovedStoryboard} from '../../../../packages/video-engine/src/contracts.js';
import {readAssistantContext} from '../assistant/service.js';
import {assertAssistantContextText, assertAssistantInput} from '../assistant/policy.js';
import {assertProjectSafetyAvailable, assertStoryboardSafety} from '../safety/index.js';
import {createGeminiPlanner} from './planner.js';
import {assertNarrationBudget, draftFromPlanning, publicProject, publicStoryboard, normalizeSettings, settingsHash, strictObject, validateDraft, validateEmpty, validateProjectCreate, validateProjectPatch, validateRevision} from './validation.js';
import {trustedDurationFeedback, sameDurationRevisionVisuals, narrationWords} from './duration-feedback.js';

export {publicProject, publicStoryboard} from './validation.js';
export {createGeminiPlanner} from './planner.js';
const {Types} = mongoose;
const active = ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED'];
const notFound = () => new ApiError(404, 'NOT_FOUND', 'This project or storyboard is not available.');
const revisionConflict = revision => new ApiError(409, 'REVISION_CONFLICT', 'This storyboard changed. Reload the saved revision without discarding your local edits.', {details: {currentRevision: revision}});
let planningInFlight = 0;

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw notFound();
  return new Types.ObjectId(value);
}

function versionFilter(project, ownerId) {
  const filter = {_id: project._id, ownerId, deletedAt: null};
  if (!project.version) filter.$or = [{version: 0}, {version: {$exists: false}}];
  else filter.version = project.version;
  return filter;
}

export function createProjectServices({connection, config, models, planner = createGeminiPlanner(config), now = () => new Date()}) {
  const {Project, Storyboard, GenerationJob} = models;
  const clock = () => new Date(now());
  async function transact(operation) {
    const session = await connection.startSession();
    try { return await session.withTransaction(() => operation(session), {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}}); }
    catch (error) {
      if ([20, 303].includes(error.code)) throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'This action requires a transaction-capable database.', {retryable: true});
      throw error;
    } finally { await session.endSession(); }
  }
  async function ownedProject(projectId, userId, session) {
    const ownerId = objectId(String(userId));
    const project = await Project.findOne({_id: objectId(projectId), ownerId, deletedAt: null}).session(session || null).lean();
    if (!project) throw notFound();
    return project;
  }
  async function ownedStoryboard(project, storyboardId, session) {
    const storyboard = await Storyboard.findOne({_id: objectId(storyboardId), ownerId: project.ownerId, projectId: project._id}).session(session || null).lean();
    if (!storyboard) throw notFound();
    return storyboard;
  }
  async function idle(project, session) {
    if (await GenerationJob.exists({projectId: project._id, ownerId: project.ownerId, status: {$in: active}}).session(session || null)) throw new ApiError(409, 'PROJECT_BUSY', 'Cancel or finish the current render before changing this project.');
  }
  async function touch(project, update, session, additional = {}) {
    const result = await Project.findOneAndUpdate({...versionFilter(project, project.ownerId), ...additional}, {...update, $inc: {...update.$inc, version: 1}}, {returnDocument: 'after', session}).lean();
    if (!result) throw new ApiError(409, 'PROJECT_CHANGED', 'This project changed. Reload it and try again.');
    return result;
  }
  function current(project, storyboard) {
    if (String(project.currentStoryboardId) !== String(storyboard._id)) throw new ApiError(409, 'REVISION_CONFLICT', 'A newer storyboard is selected for this project. Reload it before continuing.');
  }
  const sameSettings = (project, storyboard) => settingsHash(project.settings) === settingsHash(storyboard.settingsSnapshot);
  async function durationSource(project, input, session) {
    const job = await GenerationJob.findOne({_id: objectId(input.generationId), ownerId: project.ownerId, projectId: project._id}).session(session).lean();
    if (!job) throw notFound();
    const feedback = trustedDurationFeedback(job);
    if (!feedback) throw new ApiError(409, 'DURATION_FEEDBACK_UNAVAILABLE', 'This attempt has no verified narration timing. Generate and review a new script instead.');
    if (String(job.storyboardId) !== input.storyboardId || job.approvedRevision !== input.expectedRevision) throw new ApiError(409, 'DURATION_SOURCE_CHANGED', 'Use the exact approved script that produced this timing measurement.');
    const storyboard = await ownedStoryboard(project, input.storyboardId, session);
    if (storyboard.status !== 'APPROVED' || storyboard.revision !== input.expectedRevision || !sameSettings(project, storyboard) || hashApprovedStoryboard(publicStoryboard(storyboard)) !== job.storyboardHash) throw new ApiError(409, 'DURATION_SOURCE_CHANGED', 'The script or project settings changed. Generate and review a new script with the current settings.');
    assertStoryboardSafety(storyboard);
    validateDraft(publicStoryboard(storyboard));
    return {job, feedback, storyboard};
  }

  return {
    async create(userId, input) {
      const fields = validateProjectCreate(input);
      assertAssistantInput(fields.prompt);
      assertAssistantContextText(fields.title, 120);
      return publicProject((await Project.create({...fields, ownerId: objectId(String(userId)), phase: 'DRAFT', version: 0})).toObject());
    },
    async read(userId, projectId) { return publicProject(await ownedProject(projectId, userId)); },
    async patch(userId, projectId, input) {
      const fields = validateProjectPatch(input);
      if (fields.title !== undefined) assertAssistantContextText(fields.title, 120);
      return transact(async session => {
        const project = await ownedProject(projectId, userId, session);
        assertProjectSafetyAvailable(project);
        const previousSettings = normalizeSettings(project.settings);
        const settings = fields.settings ? normalizeSettings({...previousSettings, ...fields.settings}) : previousSettings;
        const changed = settingsHash(settings) !== settingsHash(previousSettings);
        if (changed) await idle(project, session);
        const updated = await touch(project, {$set: {...(fields.title !== undefined ? {title: fields.title} : {}), ...(changed ? {settings, currentStoryboardId: null, phase: 'DRAFT', planningToken: null, planningExpiresAt: null} : {})}}, session);
        return publicProject(updated);
      });
    },
    async remove(userId, projectId) {
      return transact(async session => {
        const project = await ownedProject(projectId, userId, session);
        await idle(project, session);
        const time = clock();
        await touch(project, {$set: {deletedAt: time, cleanupScheduledAt: time, planningToken: null, planningExpiresAt: null, assistantLeaseToken: null, assistantLeaseExpiresAt: null}}, session);
        return {projectId: String(project._id), status: 'DELETION_SCHEDULED'};
      });
    },
    async getStoryboard(userId, projectId, storyboardId) {
      const project = await ownedProject(projectId, userId);
      if (storyboardId === 'current' && !project.currentStoryboardId) throw notFound();
      const storyboard = await ownedStoryboard(project, storyboardId === 'current' ? String(project.currentStoryboardId) : storyboardId);
      return publicStoryboard(storyboard);
    },
    async edit(userId, projectId, storyboardId, input) {
      validateRevision(input, {edit: true});
      return transact(async session => {
        const project = await ownedProject(projectId, userId, session);
        assertProjectSafetyAvailable(project);
        await idle(project, session);
        const storyboard = await ownedStoryboard(project, storyboardId, session);
        current(project, storyboard);
        if (storyboard.status !== 'DRAFT') throw new ApiError(409, 'STORYBOARD_IMMUTABLE', 'Approved storyboards cannot be edited. Generate a new draft to make changes.');
        if (storyboard.revision !== input.expectedRevision) throw revisionConflict(storyboard.revision);
        if (!sameSettings(project, storyboard)) throw new ApiError(409, 'REVISION_REQUIRED', 'The project settings changed. Generate and review a new draft.');
        const value = {...publicStoryboard(storyboard), revision: storyboard.revision + 1, scenes: structuredClone(input.scenes), updatedAt: clock().toISOString()};
        validateDraft(value); assertStoryboardSafety(value);
        const updated = await Storyboard.findOneAndUpdate({_id: storyboard._id, ownerId: project.ownerId, projectId: project._id, status: 'DRAFT', revision: input.expectedRevision}, {$set: {scenes: value.scenes, updatedAt: new Date(value.updatedAt)}, $inc: {revision: 1}}, {returnDocument: 'after', session}).lean();
        if (!updated) throw revisionConflict(storyboard.revision);
        await touch(project, {$set: {phase: 'REVIEW'}}, session, {currentStoryboardId: storyboard._id});
        return publicStoryboard(updated);
      });
    },
    async approve(userId, projectId, storyboardId, input) {
      validateRevision(input);
      return transact(async session => {
        const project = await ownedProject(projectId, userId, session);
        assertProjectSafetyAvailable(project);
        await idle(project, session);
        const storyboard = await ownedStoryboard(project, storyboardId, session);
        current(project, storyboard);
        if (storyboard.revision !== input.expectedRevision) throw revisionConflict(storyboard.revision);
        if (!sameSettings(project, storyboard)) throw new ApiError(409, 'REVISION_REQUIRED', 'Changed settings require a new storyboard and approval.');
        assertStoryboardSafety(storyboard);
        if (storyboard.status === 'APPROVED') return {id: String(storyboard._id), revision: storyboard.revision, status: 'APPROVED', approvedAt: new Date(storyboard.approvedAt).toISOString()};
        const time = clock();
        const value = {...publicStoryboard(storyboard), status: 'APPROVED', approvedAt: time.toISOString(), updatedAt: time.toISOString()};
        validateDraft(value); assertStoryboardSafety(value); assertNarrationBudget(value);
        const contentHash = hashApprovedStoryboard(value);
        const updated = await Storyboard.findOneAndUpdate({_id: storyboard._id, ownerId: project.ownerId, projectId: project._id, status: 'DRAFT', revision: input.expectedRevision}, {$set: {status: 'APPROVED', approvedAt: time, updatedAt: time, contentHash}}, {returnDocument: 'after', session}).lean();
        if (!updated) throw revisionConflict(storyboard.revision);
        await touch(project, {$set: {phase: 'REVIEW'}}, session, {currentStoryboardId: storyboard._id});
        return {id: String(updated._id), revision: updated.revision, status: 'APPROVED', approvedAt: new Date(updated.approvedAt).toISOString()};
      });
    },
    async generate(userId, projectId, input, {signal} = {}) {
      validateEmpty(input);
      if (planningInFlight >= 2) throw new ApiError(429, 'AI_BUSY', 'Script generation is busy. Try again shortly.', {retryable: true});
      planningInFlight++;
      let claimed;
      let conversation;
      const token = randomUUID();
      try {
        claimed = await transact(async session => {
          const project = await ownedProject(projectId, userId, session);
          assertProjectSafetyAvailable(project);
          await idle(project, session);
          const time = clock();
          if (project.assistantLeaseToken && project.assistantLeaseExpiresAt && new Date(project.assistantLeaseExpiresAt) > time) throw new ApiError(409, 'ASSISTANT_IN_PROGRESS', 'Wait for the current assistant reply before generating a script.', {retryable: true});
          if (project.planningToken && project.planningExpiresAt && new Date(project.planningExpiresAt) > time) throw new ApiError(409, 'PLANNING_IN_PROGRESS', 'A script is already being generated for this project. Wait briefly, then refresh.');
          conversation = await readAssistantContext({models, project, session, config});
          const expires = new Date(time.getTime() + Math.max(120000, (config.geminiTimeoutMs || 45000) * Math.min(2, config.planningMaxAttempts || 2) + 30000));
          return touch(project, {$set: {planningToken: token, planningExpiresAt: expires}}, session);
        });
        assertAssistantInput(claimed.prompt);
        for (const turn of conversation.messages) assertAssistantContextText(turn.content, turn.role === 'USER' ? 2000 : 4000);
        const output = await planner({prompt: claimed.prompt, settings: normalizeSettings(claimed.settings), conversation: conversation.messages, conversationRevision: conversation.conversationRevision, signal});
        const draft = draftFromPlanning(output, {id: new Types.ObjectId(), projectId: claimed._id, settings: claimed.settings, now: clock()});
        assertStoryboardSafety(draft);
        return await transact(async session => {
          const project = await ownedProject(projectId, userId, session);
          assertProjectSafetyAvailable(project);
          await idle(project, session);
          if (project.planningToken !== token || settingsHash(project.settings) !== settingsHash(claimed.settings) || project.prompt !== claimed.prompt || (project.assistantConversationRevision || 0) !== conversation.conversationRevision) throw new ApiError(409, 'PROJECT_CHANGED', 'The project or saved conversation changed during generation. Generate a new draft with the current context.');
          const [storyboard] = await Storyboard.create([{_id: objectId(draft.id), ownerId: project.ownerId, projectId: project._id, revision: 1, status: 'DRAFT', schemaVersion: 1, targetDurationSec: draft.targetDurationSec, settingsSnapshot: draft.settingsSnapshot, scenes: draft.scenes, parentStoryboardId: null, approvedAt: null, contentHash: null, sourceConversationRevision: conversation.conversationRevision, sourceConversationHash: canonicalHash({conversationRevision: conversation.conversationRevision, messages: conversation.messages}), createdAt: new Date(draft.createdAt), updatedAt: new Date(draft.updatedAt)}], {session});
          await touch(project, {$set: {currentStoryboardId: storyboard._id, phase: 'REVIEW', planningToken: null, planningExpiresAt: null}}, session, {planningToken: token});
          return publicStoryboard(storyboard.toObject());
        });
      } finally {
        planningInFlight--;
        if (claimed) await Project.updateOne({_id: claimed._id, ownerId: claimed.ownerId, planningToken: token}, {$set: {planningToken: null, planningExpiresAt: null}, $inc: {version: 1}}).catch(() => {});
      }
    },
    async reviseDuration(userId, projectId, input, {signal} = {}) {
      strictObject(input, ['generationId', 'storyboardId', 'expectedRevision'], ['generationId', 'storyboardId', 'expectedRevision']);
      objectId(input.generationId); objectId(input.storyboardId);
      validateRevision({expectedRevision: input.expectedRevision});
      // Ownership is resolved before exposing process capacity or admitting work.
      const initial = await ownedProject(projectId, userId);
      assertProjectSafetyAvailable(initial);
      if (planningInFlight >= 2) throw new ApiError(429, 'AI_BUSY', 'Script generation is busy. Try again shortly.', {retryable: true});
      planningInFlight++;
      const token = randomUUID();
      let claimed, source, conversation;
      try {
        const admission = await transact(async session => {
          const project = await ownedProject(projectId, userId, session);
          assertProjectSafetyAvailable(project);
          source = await durationSource(project, input, session);
          const selected = project.currentStoryboardId ? await Storyboard.findOne({_id: project.currentStoryboardId, ownerId: project.ownerId, projectId: project._id}).session(session).lean() : null;
          if (selected?.status === 'DRAFT' && String(selected.sourceDurationGenerationId) === String(source.job._id) && String(selected.parentStoryboardId) === input.storyboardId && sameSettings(project, selected)) return {replay: publicStoryboard(selected)};
          if (String(project.currentStoryboardId) !== input.storyboardId) throw new ApiError(409, 'DURATION_SOURCE_CHANGED', 'Another draft is now selected. Review that draft before requesting another duration correction.');
          await idle(project, session);
          const time = clock();
          if (project.assistantLeaseToken && project.assistantLeaseExpiresAt && new Date(project.assistantLeaseExpiresAt) > time) throw new ApiError(409, 'ASSISTANT_IN_PROGRESS', 'Wait for the current assistant reply before revising the script.', {retryable: true});
          if (project.planningToken && project.planningExpiresAt && new Date(project.planningExpiresAt) > time) throw new ApiError(409, 'PLANNING_IN_PROGRESS', 'A script is already being generated. Wait briefly, then check the saved draft.');
          conversation = await readAssistantContext({models, project, session, config});
          const expires = new Date(time.getTime() + Math.max(120000, (config.geminiTimeoutMs || 45000) * Math.min(2, config.planningMaxAttempts || 2) + 30000));
          return {project: await touch(project, {$set: {planningToken: token, planningExpiresAt: expires}}, session)};
        });
        if (admission.replay) return admission.replay;
        claimed = admission.project;
        assertAssistantInput(claimed.prompt);
        for (const turn of conversation.messages) assertAssistantContextText(turn.content, turn.role === 'USER' ? 2000 : 4000);
        const output = await planner({prompt: claimed.prompt, settings: normalizeSettings(claimed.settings), conversation: conversation.messages, conversationRevision: conversation.conversationRevision, durationRevision: {feedback: source.feedback, scenes: structuredClone(source.storyboard.scenes)}, signal});
        if (!sameDurationRevisionVisuals(source.storyboard, output)) throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The duration revision changed the saved scene layout. Your approved script is unchanged; try again.', {retryable: true});
        const draft = draftFromPlanning(output, {id: new Types.ObjectId(), projectId: claimed._id, settings: claimed.settings, now: clock()});
        assertStoryboardSafety(draft);
        draft.parentStoryboardId = input.storyboardId;
        const revisedWords = narrationWords(draft);
        if ((source.feedback.direction === 'SHORTEN' ? revisedWords >= source.feedback.narrationWords : revisedWords <= source.feedback.narrationWords) || Math.abs(revisedWords - source.feedback.suggestedNarrationWords) > Math.max(5, Math.ceil(source.feedback.suggestedNarrationWords * 0.08))) throw new ApiError(502, 'AI_INVALID_OUTPUT', 'The revised narration did not follow the measured length guidance. Your approved script is unchanged; try again.', {retryable: true});
        return await transact(async session => {
          const project = await ownedProject(projectId, userId, session);
          assertProjectSafetyAvailable(project);
          await idle(project, session);
          if (project.planningToken !== token || String(project.currentStoryboardId) !== input.storyboardId || settingsHash(project.settings) !== settingsHash(claimed.settings) || project.prompt !== claimed.prompt || (project.assistantConversationRevision || 0) !== conversation.conversationRevision) throw new ApiError(409, 'PROJECT_CHANGED', 'The project or saved conversation changed while revising. Review the current draft and try again.');
          await durationSource(project, input, session);
          const [storyboard] = await Storyboard.create([{_id: objectId(draft.id), ownerId: project.ownerId, projectId: project._id, revision: 1, status: 'DRAFT', schemaVersion: 1, targetDurationSec: draft.targetDurationSec, settingsSnapshot: draft.settingsSnapshot, scenes: draft.scenes, parentStoryboardId: objectId(input.storyboardId), approvedAt: null, contentHash: null, sourceDurationGenerationId: source.job._id, sourceConversationRevision: conversation.conversationRevision, sourceConversationHash: canonicalHash({conversationRevision: conversation.conversationRevision, messages: conversation.messages}), createdAt: new Date(draft.createdAt), updatedAt: new Date(draft.updatedAt)}], {session});
          await touch(project, {$set: {currentStoryboardId: storyboard._id, phase: 'REVIEW', planningToken: null, planningExpiresAt: null}}, session, {planningToken: token});
          return publicStoryboard(storyboard.toObject());
        });
      } finally {
        planningInFlight--;
        if (claimed) await Project.updateOne({_id: claimed._id, ownerId: claimed.ownerId, planningToken: token}, {$set: {planningToken: null, planningExpiresAt: null}, $inc: {version: 1}}).catch(() => {});
      }
    },
  };
}

export function buildProjectRouter(options) {
  const router = Router();
  const services = createProjectServices(options);
  const planningLimit = rateLimit({windowMs: 15 * 60 * 1000, limit: options.config.planningRateLimit ?? 5, keyGenerator: req => req.auth.userId, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many script requests. Please wait before trying again.', {retryable: true}))});
  router.post('/projects', async (req, res) => sendData(req, res, await services.create(req.auth.userId, req.body), 201));
  router.get('/projects/:projectId', async (req, res) => sendData(req, res, await services.read(req.auth.userId, req.params.projectId)));
  router.patch('/projects/:projectId', async (req, res) => sendData(req, res, await services.patch(req.auth.userId, req.params.projectId, req.body)));
  router.delete('/projects/:projectId', async (req, res) => {validateEmpty(req.body); return sendData(req, res, await services.remove(req.auth.userId, req.params.projectId), 202);});
  router.post('/projects/:projectId/storyboards/generate', planningLimit, async (req, res) => {
    const abort = new AbortController();
    const close = () => {if (!res.writableEnded) abort.abort();};
    res.once('close', close);
    try { return sendData(req, res, await services.generate(req.auth.userId, req.params.projectId, req.body, {signal: abort.signal}), 201); }
    finally { res.off('close', close); }
  });
  router.post('/projects/:projectId/storyboards/revise-duration', planningLimit, async (req, res) => {
    const abort = new AbortController();
    const close = () => {if (!res.writableEnded) abort.abort();};
    res.once('close', close);
    try {return sendData(req, res, await services.reviseDuration(req.auth.userId, req.params.projectId, req.body, {signal: abort.signal}), 201);}
    finally {res.off('close', close);}
  });
  router.get('/projects/:projectId/storyboards/current', async (req, res) => sendData(req, res, await services.getStoryboard(req.auth.userId, req.params.projectId, 'current')));
  router.get('/projects/:projectId/storyboards/:storyboardId', async (req, res) => sendData(req, res, await services.getStoryboard(req.auth.userId, req.params.projectId, req.params.storyboardId)));
  router.patch('/projects/:projectId/storyboards/:storyboardId', async (req, res) => sendData(req, res, await services.edit(req.auth.userId, req.params.projectId, req.params.storyboardId, req.body)));
  router.post('/projects/:projectId/storyboards/:storyboardId/approve', async (req, res) => sendData(req, res, await services.approve(req.auth.userId, req.params.projectId, req.params.storyboardId, req.body)));
  router.post('/projects/:projectId/storyboards/:storyboardId/fork', async () => {throw new ApiError(422, 'FEATURE_UNAVAILABLE', 'Storyboard forking is not enabled. Generate a new draft instead.');});
  return router;
}
