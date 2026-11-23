import {createSessionTransport} from './session-transport.js';
import {codePoints, friendlyError} from './forms.js';

const fields = ['durationSec', 'mode', 'language', 'aspectRatio', 'tone', 'visualStyle', 'characterAssetId'];
const choices = {durationSec: [30, 60, 90], mode: ['FACELESS'], language: ['en'], aspectRatio: ['16:9'], tone: ['EDUCATIONAL'], visualStyle: ['MOTION_GRAPHICS'], characterAssetId: [null]};
const labels = {durationSec: 'Duration', mode: 'Video mode', language: 'Narration language', aspectRatio: 'Format', tone: 'Tone', visualStyle: 'Visual style', characterAssetId: 'Character image'};
export const assistantRoute = projectId => `/app/projects/${encodeURIComponent(projectId)}/assistant`;
export const assistantProjectTitle = prompt => Array.from(prompt.trim().replace(/\s+/gu, ' ')).slice(0, 90).join('') || 'A new video idea';
export function assistantInputError(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || codePoints(value) > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return 'Write a message using 1–2,000 characters.';
  if (/AIza[0-9A-Za-z_-]{35}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}/u.test(value)) return 'This looks like a credential. Remove API keys, tokens and private keys before sending.';
  return '';
}

export function mergeAssistantHistory(...pages) {
  const byId = new Map();
  for (const message of pages.flat()) if (message && typeof message.id === 'string' && Number.isSafeInteger(message.conversationRevision) && ['USER', 'ASSISTANT'].includes(message.role)) byId.set(message.id, message);
  return [...byId.values()].sort((first, second) => first.conversationRevision - second.conversationRevision);
}
export function latestAssistantSuggestion(messages) {
  return [...messages].reverse().find(message => message.role === 'ASSISTANT')?.suggestedSettings || {};
}
export function suggestedSettingsChanges(current, proposed) {
  if (!proposed || Array.isArray(proposed) || typeof proposed !== 'object' || Object.keys(proposed).some(key => !fields.includes(key) || !choices[key].includes(proposed[key]))) return null;
  return Object.fromEntries(fields.filter(key => Object.hasOwn(proposed, key) && (current?.[key] ?? null) !== proposed[key]).map(key => [key, proposed[key]]));
}
export function settingLabel(key) {return labels[key] || key;}
export function settingText(key, value) {
  if (key === 'durationSec') return `${value} seconds`;
  return {FACELESS: 'Faceless explainer', en: 'English', EDUCATIONAL: 'Educational', MOTION_GRAPHICS: 'Motion graphics'}[value] || (value === null ? 'None' : String(value));
}
export function assistantError(error) {
  const code = error?.data?.error?.code;
  const messages = {
    PROVIDER_UNAVAILABLE: 'The AI assistant is unavailable right now. Your project and saved conversation are safe. Try again later.',
    AI_QUOTA_EXCEEDED: 'The AI request allowance is currently unavailable or exhausted. Try later; video generation slots are counted separately.',
    ASSISTANT_IN_PROGRESS: 'Another message is being answered for this project. Refresh the saved conversation before sending again.',
    ASSISTANT_REQUEST_IN_PROGRESS: 'This request is still being answered. Check for its saved reply shortly.',
    ASSISTANT_REQUEST_NOT_FOUND: 'No saved receipt was found yet. Retry the same request to submit or recover it once.',
    ASSISTANT_REQUEST_EXPIRED: 'The previous request expired. Check the saved conversation, then send again if a reply is still needed.',
    ASSISTANT_HISTORY_LIMIT: 'This conversation has reached its saved-message limit. Start a new project to discuss another idea.',
    CONVERSATION_LIMIT: 'This conversation has reached its saved-message limit. Start a new project to discuss another idea.',
    PROJECT_CHANGED: 'The project changed while this message was being answered. Your text is preserved. Refresh the project before sending again.',
    PLANNING_IN_PROGRESS: 'A script is already being prepared. Check the saved draft before sending another message.',
    SENSITIVE_INPUT: 'Remove API keys, passwords, tokens and other private credentials before sending.',
    CONTENT_REJECTED: 'The assistant cannot help with this request. Revise the message and try again.',
    AI_INVALID_OUTPUT: 'The assistant could not produce a valid reply. Your text is preserved; you can try again.',
    AI_TIMEOUT: 'The assistant took too long. Your message is preserved. You can try again.',
    AI_PROVIDER_FAILED: 'The assistant could not finish this request. Your text is preserved; you can try again.',
    IDEMPOTENCY_CONFLICT: 'This request differs from its earlier submission. Check the saved history before sending a new message.',
    IDEMPOTENCY_MISMATCH: 'This request differs from its earlier submission. Check the saved history before sending a new message.',
  };
  return messages[code] || friendlyError(error, 'The conversation could not be updated. Your text is preserved.');
}

export function assistantRequestUncertain(error) {
  const code = error?.data?.error?.code;
  if (['ASSISTANT_REQUEST_IN_PROGRESS', 'ASSISTANT_REQUEST_NOT_FOUND'].includes(code)) return true;
  if (['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'].includes(error?.status)) return true;
  return Number(error?.status) >= 500 && !['PROVIDER_UNAVAILABLE', 'AI_TIMEOUT', 'AI_PROVIDER_FAILED', 'AI_INVALID_OUTPUT'].includes(code);
}

const sessions = new Map();
let privacyVersion = 0;
export function assistantDraftSession(ownerId, projectId) {
  const scope = `${ownerId}:${projectId}`;
  if (!sessions.has(scope) || sessions.get(scope).privacyVersion !== privacyVersion) sessions.set(scope, {scope, privacyVersion, draft: '', initialized: false, pending: null, lastRevision: 0, version: 0, listeners: new Set()});
  return sessions.get(scope);
}
export const assistantPrivacyVersion = () => privacyVersion;
export function currentAssistantSession(session) {return Boolean(session && session.privacyVersion === privacyVersion && sessions.get(session.scope) === session);}
const changed = session => {session.version++; for (const listener of [...session.listeners]) listener();};
export function subscribeAssistantSession(session, listener) {if (!session) return () => {}; session.listeners.add(listener); return () => session.listeners.delete(listener);}
export function updateAssistantDraft(session, value) {if (!currentAssistantSession(session)) return; session.draft = value; session.initialized = true; changed(session);}
export function initializeAssistantDraft(session, seed) {if (!currentAssistantSession(session) || session.initialized) return; session.draft = seed; session.initialized = true; changed(session);}
export function sendingAssistantSubmission(session, pending, {replayOnly = false} = {}) {if (!currentAssistantSession(session) || session.pending !== pending) return; pending.inFlight = true; pending.uncertain = false; pending.replayOnly = replayOnly; changed(session);}
export function clearAssistantSessions() {
  const previous = [...sessions.values()];
  privacyVersion++;
  sessions.clear();
  for (const session of previous) {session.pending?.controller?.abort(); session.draft = ''; session.pending = null; session.initialized = false; changed(session);}
}
export function beginAssistantSubmission(session, revision, keyFactory = () => crypto.randomUUID()) {
  if (session.pending) return session.pending;
  const message = session.draft.trim();
  const error = assistantInputError(message);
  if (error) throw new Error(error);
  session.pending = {message, key: keyFactory(), beforeRevision: revision, controller: new AbortController(), inFlight: false, uncertain: false};
  changed(session);
  return session.pending;
}
export function acceptAssistantSubmission(session, pending, reply) {
  if (!currentAssistantSession(session) || session.pending !== pending) return false;
  if (session.draft.trim() === pending.message) session.draft = '';
  session.pending = null;
  session.lastRevision = reply.conversationRevision;
  changed(session);
  return true;
}
export function failAssistantSubmission(session, pending, error) {
  if (!currentAssistantSession(session) || session.pending !== pending) return;
  if (!assistantRequestUncertain(error)) session.pending = null;
  else {pending.inFlight = false; pending.uncertain = true;}
  changed(session);
}

/** The free-form unsaved message stays outside RTK mutation argument storage. */
export function createAssistantMessageRequest({fetchImpl = globalThis.fetch, locks = globalThis.navigator?.locks} = {}) {
  const request = async input => {
    const args = typeof input === 'string' ? {url: input, method: 'GET'} : input;
    const headers = new Headers(args.headers); headers.set('Accept', 'application/json');
    if (args.body !== undefined) headers.set('Content-Type', 'application/json');
    const timeout = AbortSignal.timeout(args.url === '/assistant/messages' ? 110000 : 15000);
    try {
      const response = await fetchImpl('/api/v1' + args.url, {method: args.method || 'GET', credentials: 'include', headers, signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout, ...(args.body !== undefined ? {body: JSON.stringify(args.body)} : {})});
      let payload; try {payload = await response.json();} catch {return {error: {status: 'PARSING_ERROR'}};}
      return response.ok ? {data: payload} : {error: {status: response.status, data: payload, retryAfter: Math.max(1, Math.min(86400, Number(response.headers.get('Retry-After')) || 2))}};
    } catch (error) {return {error: {status: error.name === 'TimeoutError' ? 'TIMEOUT_ERROR' : 'FETCH_ERROR'}};}
  };
  const transport = createSessionTransport(request, {locks});
  return async ({projectId, message, idempotencyKey, replayOnly = false, signal}) => {
    const result = await transport({url: '/assistant/messages', method: 'POST', headers: {'Idempotency-Key': idempotencyKey, ...(replayOnly ? {'X-Assistant-Replay-Only': 'true'} : {})}, body: {projectId, message}, signal});
    if (result.error) throw result.error;
    return result.data.data;
  };
}
export const requestAssistantMessage = createAssistantMessageRequest();
