import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {ApiError} from '../http.js';

export const ACTIVE = ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED'];
export const STAGES = ['PREPARE_ASSETS', 'SYNTHESIZE_AUDIO', 'ALIGN_TIMELINE', 'RENDER_VIDEO', 'VALIDATE_OUTPUT', 'UPLOAD_OUTPUT'];
export const QUEUE_ID = 'generation-capacity';
export const id = value => String(value);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const missing = () => new ApiError(404, 'NOT_FOUND', 'This project or generation is not available.');
export const objectId = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw missing();
  return value;
};
export function strictBody(body, fields, required = fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new ApiError(422, 'VALIDATION_FAILED', 'Check the request fields and try again.');
}
export function emptyBody(body) {if (body !== undefined) strictBody(body, [], []);}
export function idempotencyKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200 || !/^[\x21-\x7E]+$/u.test(value)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key between 8 and 200 printable characters.');
  return sha256(value);
}
export function publicGeneration(job) {
  return {id: id(job._id), projectId: id(job.projectId), storyboardId: id(job.storyboardId), approvedRevision: job.approvedRevision, status: job.status, stage: job.stage ?? null, progress: {completedStages: job.progress?.completedStages ?? 0, totalStages: 6}, attempt: job.attempt ?? 0, outputAssetId: job.outputAssetId ? id(job.outputAssetId) : null, captionAssetId: job.captionAssetId ? id(job.captionAssetId) : null, error: job.error ? {code: job.error.code, message: job.error.message, retryable: Boolean(job.error.retryable)} : null, createdAt: new Date(job.createdAt).toISOString(), updatedAt: new Date(job.updatedAt).toISOString()};
}
export function admissionReceipt(job) {return {generationId: id(job._id), projectId: id(job.projectId), storyboardId: id(job.storyboardId), approvedRevision: job.approvedRevision, status: 'QUEUED', stage: null, statusUrl: '/api/v1/generations/' + id(job._id)};}
export const cancelReceipt = job => ({generationId: id(job._id), status: job.status, statusUrl: '/api/v1/generations/' + id(job._id)});
export const settingsIdentity = settings => ({...settings, characterAssetId: settings.characterAssetId ?? null});
export const utcDay = date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const cursorSignature = (payload, secret) => createHmac('sha256', secret).update('generations.page.v1\0' + payload).digest('base64url');
export function encodeGenerationCursor(job, ownerId, secret) {
  const payload = Buffer.from(JSON.stringify({ownerId: id(ownerId), projectId: id(job.projectId), createdAt: new Date(job.createdAt).toISOString(), id: id(job._id)})).toString('base64url');
  return payload + '.' + cursorSignature(payload, secret);
}
export function decodeGenerationCursor(cursor, ownerId, projectId, secret) {
  const fail = () => new ApiError(400, 'INVALID_QUERY', 'Choose a valid generation page.');
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(cursor)) throw fail();
  const [payload, signature] = cursor.split('.');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(cursorSignature(payload, secret)))) throw fail();
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Object.keys(value).sort().join(',') !== 'createdAt,id,ownerId,projectId' || value.ownerId !== id(ownerId) || value.projectId !== id(projectId) || !/^[a-f0-9]{24}$/u.test(value.id) || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt) throw fail();
    return {id: value.id, createdAt: new Date(value.createdAt)};
  } catch {throw fail();}
}
