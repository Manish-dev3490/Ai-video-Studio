import {createHmac, timingSafeEqual} from 'node:crypto';
import {ApiError} from '../http.js';

const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'This conversation cursor is invalid. Reload the saved history.');
const signature = (payload, config) => createHmac('sha256', config.csrfSecret || config.jwtSecret).update('assistant-history-v1.' + payload).digest('base64url');
export function encodeAssistantCursor({ownerId, projectId, after}, config) {
  const payload = Buffer.from(JSON.stringify({v: 1, ownerId: String(ownerId), projectId: String(projectId), after})).toString('base64url');
  return payload + '.' + signature(payload, config);
}
export function decodeAssistantCursor(value, {ownerId, projectId}, config) {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw invalid();
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[1])) throw invalid();
    const expected = signature(parts[0], config), actual = parts[1];
    if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw invalid();
    const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (decoded.v !== 1 || decoded.ownerId !== String(ownerId) || decoded.projectId !== String(projectId) || !Number.isSafeInteger(decoded.after) || decoded.after < 1 || Object.keys(decoded).length !== 4) throw invalid();
    return decoded.after;
  } catch {throw invalid();}
}
