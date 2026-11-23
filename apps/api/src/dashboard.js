import {createHmac, timingSafeEqual} from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import {ApiError} from './http.js';

const {Schema, Types} = mongoose;
const phases = ['DRAFT', 'REVIEW', 'RENDERING', 'HAS_OUTPUT'];
const activeStates = ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED'];
const settingsSchema = new Schema({
  mode: {type: String, enum: ['FACELESS', 'CHARACTER_2D'], required: true},
  durationSec: {type: Number, enum: [30, 60, 90], required: true},
  language: {type: String, enum: ['en', 'hi'], required: true},
  aspectRatio: {type: String, enum: ['16:9', '9:16'], required: true},
  tone: {type: String, required: true},
  visualStyle: {type: String, required: true},
  characterAssetId: {type: String, default: null},
}, {_id: false, strict: 'throw'});

/** Read models only in Phase 3; no draft creation, quota reservation or job API. */
export function createDashboardModels(connection) {
  const projectSchema = new Schema({
    ownerId: {type: Schema.Types.ObjectId, required: true},
    title: {type: String, required: true, maxlength: 120},
    prompt: {type: String, required: true, maxlength: 2000},
    settings: {type: settingsSchema, required: true},
    phase: {type: String, enum: phases, default: 'DRAFT'},
    currentStoryboardId: {type: Schema.Types.ObjectId, default: null},
    latestGenerationId: {type: Schema.Types.ObjectId, default: null},
    latestOutputAssetId: {type: Schema.Types.ObjectId, default: null},
    deletedAt: {type: Date, default: null},
  }, {collection: 'projects', timestamps: true, strict: 'throw'});
  projectSchema.index({ownerId: 1, deletedAt: 1, updatedAt: -1, _id: -1});
  const bucketSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, required: true},
    periodStart: {type: Date, required: true},
    limit: {type: Number, min: 0, required: true},
    reserved: {type: Number, min: 0, default: 0},
    consumed: {type: Number, min: 0, default: 0},
  }, {collection: 'usageBuckets', timestamps: {createdAt: false, updatedAt: true}});
  bucketSchema.index({userId: 1, periodStart: 1}, {unique: true});
  const jobSchema = new Schema({
    ownerId: Schema.Types.ObjectId,
    status: String,
    deletedAt: {type: Date, default: null},
  }, {collection: 'generationJobs', strict: false});
  jobSchema.index({ownerId: 1, status: 1});
  return {
    Project: connection.models.Project || connection.model('Project', projectSchema),
    UsageBucket: connection.models.UsageBucket || connection.model('UsageBucket', bucketSchema),
    GenerationJob: connection.models.DashboardGenerationJob || connection.model('DashboardGenerationJob', jobSchema),
  };
}

const invalidQuery = () => new ApiError(400, 'INVALID_QUERY', 'Choose a valid project page and a limit from 1 to 50.');
const signature = (payload, secret) => createHmac('sha256', secret).update('projects.cursor.v1\0' + payload).digest('base64url');

export function encodeProjectCursor({userId, updatedAt, id}, secret) {
  const payload = Buffer.from(JSON.stringify({v: 1, userId: String(userId), updatedAt: new Date(updatedAt).toISOString(), id: String(id)})).toString('base64url');
  return payload + '.' + signature(payload, secret);
}

export function decodeProjectCursor(cursor, userId, secret) {
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor)) throw invalidQuery();
  const [payload, supplied] = cursor.split('.');
  const expected = signature(payload, secret);
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw invalidQuery();
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || Object.keys(data).sort().join(',') !== 'id,updatedAt,userId,v' || data.userId !== String(userId) || !/^[a-f0-9]{24}$/u.test(data.id) || typeof data.updatedAt !== 'string' || new Date(data.updatedAt).toISOString() !== data.updatedAt) throw invalidQuery();
    return {id: new Types.ObjectId(data.id), updatedAt: new Date(data.updatedAt)};
  } catch { throw invalidQuery(); }
}

function publicProject(project) {
  const settings = Object.fromEntries(['mode', 'durationSec', 'language', 'aspectRatio', 'tone', 'visualStyle', 'characterAssetId'].filter(key => project.settings[key] !== undefined).map(key => [key, project.settings[key]]));
  return {id: String(project._id), title: project.title, prompt: project.prompt, settings, phase: project.phase, currentStoryboardId: project.currentStoryboardId ? String(project.currentStoryboardId) : null, latestGenerationId: project.latestGenerationId ? String(project.latestGenerationId) : null, latestOutputAssetId: project.latestOutputAssetId ? String(project.latestOutputAssetId) : null, createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString()};
}

export function buildDashboardRouter({connection, config, now = () => new Date()}) {
  const router = express.Router();
  const {Project, UsageBucket, GenerationJob} = createDashboardModels(connection);
  const send = (req, res, data) => res.json({data, meta: {requestId: req.requestId}});
  router.get('/projects', async (req, res) => {
    if (Object.keys(req.query).some(key => !['limit', 'cursor'].includes(key))) throw invalidQuery();
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d?$/u.test(rawLimit) || Number(rawLimit) > 50)) throw invalidQuery();
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    const ownerId = new Types.ObjectId(req.auth.userId);
    const filter = {ownerId, deletedAt: null};
    if (req.query.cursor !== undefined) {
      const cursor = decodeProjectCursor(req.query.cursor, ownerId, config.csrfSecret);
      filter.$or = [{updatedAt: {$lt: cursor.updatedAt}}, {updatedAt: cursor.updatedAt, _id: {$lt: cursor.id}}];
    }
    const documents = await Project.find(filter).sort({updatedAt: -1, _id: -1}).limit(limit + 1).lean();
    const page = documents.slice(0, limit);
    const last = page.at(-1);
    return send(req, res, {projects: page.map(publicProject), nextCursor: documents.length > limit && last ? encodeProjectCursor({userId: ownerId, updatedAt: last.updatedAt, id: last._id}, config.csrfSecret) : null});
  });
  router.get('/usage', async (req, res) => {
    if (Object.keys(req.query).length) throw new ApiError(400, 'INVALID_QUERY', 'Usage does not accept query parameters.');
    const date = now();
    const periodStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const resetAt = new Date(periodStart.getTime() + 86400000).toISOString();
    const ownerId = new Types.ObjectId(req.auth.userId);
    const [bucket, activeJobs, queuedJobs] = await Promise.all([
      UsageBucket.findOne({userId: ownerId, periodStart}).lean(),
      GenerationJob.countDocuments({ownerId, deletedAt: null, status: {$in: activeStates}}),
      GenerationJob.countDocuments({ownerId, deletedAt: null, status: 'QUEUED'}),
    ]);
    const dailyLimit = bucket?.limit ?? config.dailyGenerationLimit ?? 3;
    const used = bucket?.consumed ?? 0;
    const reserved = bucket?.reserved ?? 0;
    return send(req, res, {dailyLimit, used, reserved, activeJobs, queuedJobs, resetAt, nextEligibleAt: used + reserved >= dailyLimit ? resetAt : null});
  });
  router.get('/capabilities', async (req, res) => {
    if (Object.keys(req.query).length) throw new ApiError(400, 'INVALID_QUERY', 'Capabilities do not accept query parameters.');
    const queue = connection.models.QueueState ? await connection.models.QueueState.findById('generation-capacity').lean() : null;
    const online = Boolean(queue?.workerId && queue.workerHeartbeatAt && now().getTime() - new Date(queue.workerHeartbeatAt).getTime() < (config.workerOfflineMs || 30000));
    const waiting = online ? await GenerationJob.countDocuments({status: 'QUEUED'}) : 0;
    const worker = {available: online && waiting < 2 && (queue.activeCount || 0) < 3, status: !online ? 'OFFLINE' : queue.runningJobId || waiting >= 2 ? 'BUSY' : 'ONLINE'};
    return send(req, res, {durationsSec: [30, 60, 90], languages: ['en'], modes: ['FACELESS'], aspectRatios: ['16:9'], worker, characterMode: {enabled: false, reason: 'Custom character generation is not available in this release.'}, templates: ['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS']});
  });
  return router;
}
