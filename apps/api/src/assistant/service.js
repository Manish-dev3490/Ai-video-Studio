import {createHash, createHmac, randomUUID} from 'node:crypto';
import {ApiError} from '../http.js';
import {assertProjectSafetyAvailable} from '../safety/index.js';
import {normalizeSettings, settingsHash} from '../projects/validation.js';
import {createGeminiAssistant, validateAssistantReply} from './provider.js';
import {assertAssistantInput, assertAssistantContextText} from './policy.js';
import {encodeAssistantCursor, decodeAssistantCursor} from './cursors.js';
import {historyQuery, idempotencyKey, notFound, objectIdText, publicAssistantMessage, validateAssistantRequest} from './validation.js';

let inFlight = 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = project => project.assistantConversationRevision ?? 0;
const busy = () => new ApiError(409, 'ASSISTANT_IN_PROGRESS', 'Another assistant turn is still running for this project. Wait, then reload its saved history.', {retryable: true, details: {requestAccepted: false}});
const expired = () => new ApiError(409, 'ASSISTANT_REQUEST_EXPIRED', 'This assistant request expired without a saved reply. Submit the message again as a new request.', {retryable: true, details: {requestAccepted: true}});
const missingReceipt = () => new ApiError(404, 'ASSISTANT_REQUEST_NOT_FOUND', 'This request was not accepted. You can send the message again.', {details: {requestAccepted: false}});
const changed = () => new ApiError(409, 'PROJECT_CHANGED', 'This project changed while the assistant was replying. Review the current settings and send the message again.', {retryable: true, details: {requestAccepted: true}});
const safeFailures = {
  CONTENT_REJECTED: [422, 'The assistant cannot help with that request. Revise the topic and try again.', false],
  SENSITIVE_INPUT: [422, 'Remove credentials and private keys before asking the assistant.', false],
  AI_INVALID_OUTPUT: [502, 'The assistant did not return a valid reply. Please try again.', true],
  AI_QUOTA_EXCEEDED: [429, 'The AI service is busy or its allowance is exhausted. Please try again later.', true],
  PROVIDER_UNAVAILABLE: [503, 'The assistant is temporarily unavailable. Please try again later.', true],
  AI_TIMEOUT: [504, 'The assistant took too long to reply. Please try again.', true],
  AI_PROVIDER_FAILED: [502, 'The assistant service could not answer. Please try again later.', true],
  AI_CONTEXT_UNAVAILABLE: [503, 'The saved conversation could not be used. Reload the project and try again.', true],
  REQUEST_ABORTED: [503, 'The assistant request was interrupted. Check its saved reply before retrying.', true],
};
function storedError(error) {
  if (['NOT_FOUND', 'PROJECT_CHANGED', 'PROJECT_SAFETY_HOLD', 'ASSISTANT_REQUEST_EXPIRED'].includes(error.code) && error instanceof ApiError) return {status: error.status, code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? {details: error.details} : {})};
  const code = Object.hasOwn(safeFailures, error.code) ? error.code : /Mongo|Mongoose/u.test(error.name || '') ? 'DATABASE_UNAVAILABLE' : 'PROVIDER_UNAVAILABLE';
  const [status, message, retryable] = safeFailures[code] || [503, 'The service is temporarily unavailable. Please try again.', true];
  return {status, code, message, retryable, details: {requestAccepted: true}};
}
function asError(value) {return new ApiError(value.status, value.code, value.message, {retryable: value.retryable, ...(value.details ? {details: value.details} : {})});}

/** Saved history is never truncated; only the provider's context is bounded. */
export async function readAssistantContext({models, project, session, config = {}}) {
  const maximumMessages = Math.floor(Math.min(12, Math.max(2, config.assistantContextMessages ?? 12)) / 2) * 2;
  const maximumCharacters = Math.min(16000, Math.max(6000, config.assistantContextChars ?? 16000));
  let query = models.AssistantMessage.find({ownerId: project.ownerId, projectId: project._id, conversationRevision: {$lte: revision(project)}}).sort({conversationRevision: -1}).limit(maximumMessages);
  if (session) query = query.session(session);
  const rows = (await query.lean()).reverse();
  const messages = rows.map(row => ({role: row.role, content: row.content}));
  let characters = messages.reduce((total, message) => total + Array.from(message.content).length, 0);
  while (characters > maximumCharacters && messages.length > 2) {
    const remove = messages[0].role === 'USER' && messages[1]?.role === 'ASSISTANT' ? 2 : 1;
    for (let index = 0; index < remove; index++) characters -= Array.from(messages.shift().content).length;
  }
  return {conversationRevision: revision(project), messages};
}

export function createAssistantServices({connection, config, models, assistant, now = Date.now}) {
  const {Project, AssistantMessage, AssistantRequest, AssistantUsageBucket} = models;
  const ask = assistant || createGeminiAssistant(config);
  const clock = () => new Date(now());
  const transact = operation => connection.transaction(operation, {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}});
  async function owned(userId, projectId, session) {
    const query = Project.findOne({_id: objectIdText(projectId), ownerId: objectIdText(String(userId)), deletedAt: null});
    if (session) query.session(session);
    const project = await query.lean();
    if (!project) throw notFound();
    assertProjectSafetyAvailable(project);
    return project;
  }
  function receiptResult(row, identity, time) {
    if (row.identityHash !== identity) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different assistant message.', {details: {requestAccepted: false}});
    if (new Date(row.expiresAt) <= time) return {kind: 'error', error: storedError(expired())};
    if (row.status === 'COMPLETED') return {kind: 'replay', response: structuredClone(row.response)};
    if (row.status === 'FAILED') return {kind: 'error', error: structuredClone(row.error)};
    if (new Date(row.leaseExpiresAt) <= time) return {kind: 'expired', error: storedError(expired())};
    return {kind: 'error', error: {status: 409, code: 'ASSISTANT_REQUEST_IN_PROGRESS', message: 'Your assistant request is still running. Check its saved reply shortly.', retryable: true, details: {requestAccepted: true}}};
  }
  async function replay(userId, projectId, keyHash, identity, session) {
    const query = AssistantRequest.findOne({ownerId: userId, keyHash}); if (session) query.session(session);
    const row = await query.lean();
    if (!row) return null;
    const result = receiptResult(row, identity, clock());
    if (result.kind === 'expired' && session) {
      await AssistantRequest.updateOne({_id: row._id, status: 'PROCESSING', leaseToken: row.leaseToken}, {$set: {status: 'FAILED', error: result.error}}).session(session);
      await Project.updateOne({_id: projectId, ownerId: userId, assistantLeaseToken: row.leaseToken}, {$set: {assistantLeaseToken: null, assistantLeaseExpiresAt: null}, $inc: {version: 1}}).session(session);
    }
    return result.kind === 'expired' ? {...result, kind: 'error', needsExpiry: !session} : result;
  }
  const unwrap = result => {if (result.kind === 'error') throw asError(result.error); return result.response;};

  async function send(userId, input, options = {}) {
    const fields = validateAssistantRequest(input);
    const message = assertAssistantInput(fields.message);
    const ownerId = objectIdText(String(userId));
    const requestKey = idempotencyKey(options.idempotencyKey);
    const keyHash = createHmac('sha256', config.csrfSecret || config.jwtSecret).update('assistant-request-v1.' + ownerId + '.' + requestKey).digest('hex');
    const identity = hash({projectId: fields.projectId, message});
    const existingProject = await owned(ownerId, fields.projectId);
    const existing = await replay(ownerId, fields.projectId, keyHash, identity);
    if (existing?.needsExpiry) return unwrap(await transact(async session => {await owned(ownerId, fields.projectId, session); return replay(ownerId, fields.projectId, keyHash, identity, session);}));
    if (existing) return unwrap(existing);
    if (options.replayOnly) {
      if (existing) return unwrap(existing);
      throw missingReceipt();
    }
    assertAssistantInput(existingProject.prompt);
    if (!assistant && (!config.geminiApiKey || !config.geminiModel)) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'The assistant is not configured. Ask the studio operator to connect Gemini.', {retryable: true, details: {requestAccepted: false}});
    if (inFlight >= (config.assistantMaxConcurrent ?? 2)) throw new ApiError(429, 'AI_BUSY', 'The assistant is busy. Please try again shortly.', {retryable: true, details: {requestAccepted: false}});
    inFlight++;
    const token = randomUUID();
    let claim;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          claim = await transact(async session => {
            const project = await owned(ownerId, fields.projectId, session);
            const found = await replay(ownerId, fields.projectId, keyHash, identity, session);
            if (found) return found;
            const time = clock();
            if (project.assistantLeaseToken && project.assistantLeaseExpiresAt && new Date(project.assistantLeaseExpiresAt) > time) throw busy();
            if (project.planningToken && project.planningExpiresAt && new Date(project.planningExpiresAt) > time) throw new ApiError(409, 'PLANNING_IN_PROGRESS', 'Wait for the current script generation before sending another assistant message.', {retryable: true, details: {requestAccepted: false}});
            if (!Number.isSafeInteger(revision(project)) || revision(project) > Number.MAX_SAFE_INTEGER - 2) throw new ApiError(429, 'CONVERSATION_LIMIT', 'This conversation is full. Start a new project to continue.', {details: {requestAccepted: false}});
            const count = await AssistantMessage.countDocuments({projectId: project._id, ownerId}).session(session);
            if (count + 2 > (config.assistantMaxMessages ?? 200)) throw new ApiError(429, 'CONVERSATION_LIMIT', 'This conversation is full. Start a new project to continue.', {details: {requestAccepted: false, maxMessages: config.assistantMaxMessages ?? 200}});
            assertAssistantInput(project.prompt);
            const context = await readAssistantContext({models, project, session, config});
            for (const entry of context.messages) assertAssistantContextText(entry.content, 4000);
            const periodStart = new Date(time); periodStart.setUTCHours(0, 0, 0, 0);
            const resetAt = new Date(periodStart.getTime() + 86400000);
            let bucket = await AssistantUsageBucket.findOne({ownerId, periodStart}).session(session).lean();
            const limit = config.assistantDailyLimit ?? 30;
            if (limit < 1 || bucket && bucket.count >= limit) throw new ApiError(429, 'AI_QUOTA_EXCEEDED', 'Your daily assistant request allowance is exhausted. Try again after the UTC reset.', {retryable: true, details: {requestAccepted: false, limit, resetAt: resetAt.toISOString()}});
            if (!bucket) [bucket] = await AssistantUsageBucket.create([{ownerId, periodStart, count: 0}], {session, ordered: true});
            const reserved = await AssistantUsageBucket.updateOne({_id: bucket._id, count: {$lt: limit}}, {$inc: {count: 1}}).session(session);
            if (reserved.modifiedCount !== 1) throw new ApiError(429, 'AI_QUOTA_EXCEEDED', 'Your daily assistant request allowance is exhausted.', {retryable: true, details: {requestAccepted: false, limit, resetAt: resetAt.toISOString()}});
            const timeoutMs = Math.min(90000, Math.max(1000, config.assistantTimeoutMs ?? config.geminiTimeoutMs ?? 45000));
            const expires = new Date(time.getTime() + Math.max(config.assistantLeaseMs ?? 120000, timeoutMs * 2 + 30000));
            const updated = await Project.findOneAndUpdate({_id: project._id, ownerId, deletedAt: null, safetyHoldAt: null}, {$set: {assistantConversationRevision: revision(project), assistantLeaseToken: token, assistantLeaseExpiresAt: expires}, $inc: {version: 1}}, {returnDocument: 'after', session}).lean();
            if (!updated) throw changed();
            const [request] = await AssistantRequest.create([{ownerId, projectId: project._id, keyHash, identityHash: identity, status: 'PROCESSING', leaseToken: token, leaseExpiresAt: expires, expectedConversationRevision: revision(project), expiresAt: new Date(time.getTime() + 86400000)}], {session, ordered: true});
            return {kind: 'claim', project: updated, request: request.toObject(), context};
          });
          break;
        } catch (error) {
          if (error.code !== 11000 || attempt === 2) throw error;
        }
      }
      if (claim.kind !== 'claim') return unwrap(claim);
      if (options.signal?.aborted) throw new ApiError(503, 'REQUEST_ABORTED', 'The request was interrupted.', {retryable: true});
      const reply = validateAssistantReply(await ask({project: {prompt: claim.project.prompt, settings: normalizeSettings(claim.project.settings)}, history: claim.context.messages, message, signal: options.signal}));
      return await transact(async session => {
        const project = await owned(ownerId, fields.projectId, session);
        const time = clock();
        if (project.assistantLeaseToken !== token || new Date(project.assistantLeaseExpiresAt) <= time) throw expired();
        if (revision(project) !== claim.context.conversationRevision || project.prompt !== claim.project.prompt || settingsHash(project.settings) !== settingsHash(claim.project.settings)) throw changed();
        const request = await AssistantRequest.findOne({_id: claim.request._id, status: 'PROCESSING', leaseToken: token}).session(session).lean();
        if (!request) throw expired();
        const next = revision(project) + 2;
        await AssistantMessage.create([
          {ownerId, projectId: project._id, role: 'USER', content: message, conversationRevision: next - 1, createdAt: time, updatedAt: time},
          {ownerId, projectId: project._id, role: 'ASSISTANT', content: reply.assistantMessage, suggestedSettings: reply.suggestedSettings, missingInformation: reply.missingInformation, conversationRevision: next, createdAt: time, updatedAt: time},
        ], {session, ordered: true});
        const updated = await Project.updateOne({_id: project._id, ownerId, deletedAt: null, safetyHoldAt: null, assistantLeaseToken: token, assistantConversationRevision: revision(project)}, {$set: {assistantConversationRevision: next, assistantLeaseToken: null, assistantLeaseExpiresAt: null}, $inc: {version: 1}}).session(session);
        if (updated.modifiedCount !== 1) throw expired();
        const response = {...reply, conversationRevision: next};
        const receipt = await AssistantRequest.updateOne({_id: request._id, status: 'PROCESSING', leaseToken: token}, {$set: {status: 'COMPLETED', response, error: null}}).session(session);
        if (receipt.modifiedCount !== 1) throw expired();
        return response;
      });
    } catch (error) {
      if (claim?.kind === 'claim') {
        const safe = storedError(error);
        await AssistantRequest.updateOne({_id: claim.request._id, status: 'PROCESSING', leaseToken: token}, {$set: {status: 'FAILED', error: safe}}).catch(() => {});
        throw asError(safe);
      }
      throw error;
    } finally {
      inFlight--;
      if (claim?.kind === 'claim') await Project.updateOne({_id: claim.project._id, ownerId, assistantLeaseToken: token}, {$set: {assistantLeaseToken: null, assistantLeaseExpiresAt: null}, $inc: {version: 1}}).catch(() => {});
    }
  }

  async function history(userId, projectId, query = {}) {
    const ownerId = objectIdText(String(userId));
    const project = await owned(ownerId, projectId);
    const {limit, cursor} = historyQuery(query);
    const after = cursor ? decodeAssistantCursor(cursor, {ownerId, projectId}, config) : 0;
    const rows = await AssistantMessage.find({ownerId, projectId: project._id, conversationRevision: {$gt: after, $lte: revision(project)}}).sort({conversationRevision: 1}).limit(limit + 1).lean();
    const more = rows.length > limit; const selected = rows.slice(0, limit);
    return {messages: selected.map(publicAssistantMessage), nextCursor: more ? encodeAssistantCursor({ownerId, projectId, after: selected.at(-1).conversationRevision}, config) : null};
  }
  return {send, sendMessage: send, history};
}

/** Soft-deletion revokes reads immediately; this bounded pass erases transcripts. */
export async function cleanupAssistantHistory({models, limit = 25}) {
  const projects = await models.Project.find({deletedAt: {$ne: null}, assistantCleanupCompletedAt: null}).select('_id').sort({deletedAt: 1}).limit(Math.min(100, Math.max(1, limit))).lean();
  let removed = 0;
  for (const project of projects) {
    const messages = await models.AssistantMessage.deleteMany({projectId: project._id});
    await models.AssistantRequest.deleteMany({projectId: project._id});
    await models.Project.updateOne({_id: project._id, deletedAt: {$ne: null}}, {$set: {assistantCleanupCompletedAt: new Date()}});
    removed += messages.deletedCount;
  }
  return {projectsChecked: projects.length, messagesRemoved: removed};
}
