import {randomUUID} from 'node:crypto';
import {ApiError} from '../http.js';

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'This project is not available.');
export const invalidRequest = () => new ApiError(422, 'VALIDATION_FAILED', 'Send a saved project and a nonblank message of at most 2,000 characters.');
export function objectIdText(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw notFound();
  return value;
}
export function validateAssistantRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['projectId', 'message'].includes(key)) || typeof input.message !== 'string' || !input.message.isWellFormed() || !input.message.trim() || Array.from(input.message).length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.message)) throw invalidRequest();
  return {projectId: objectIdText(input.projectId), message: input.message.trim()};
}
export function idempotencyKey(value) {
  if (value === undefined) return randomUUID();
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new ApiError(422, 'VALIDATION_FAILED', 'Use a valid assistant request key.');
  return value;
}
export function historyQuery(query) {
  if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) throw new ApiError(400, 'INVALID_QUERY', 'Use limit and an optional conversation cursor.');
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (typeof query.limit === 'object' || !Number.isInteger(limit) || limit < 1 || limit > 50 || query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 2048)) throw new ApiError(400, 'INVALID_QUERY', 'Use a limit between 1 and 50 and a valid cursor.');
  return {limit, cursor: query.cursor};
}
export function publicAssistantMessage(value) {
  return {id: String(value._id), role: value.role, content: value.content, conversationRevision: value.conversationRevision, createdAt: new Date(value.createdAt).toISOString(), ...(value.role === 'ASSISTANT' && value.suggestedSettings ? {suggestedSettings: structuredClone(value.suggestedSettings)} : {})};
}
