import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptAssistantSubmission, assistantDraftSession, assistantError, assistantInputError, assistantProjectTitle, assistantRequestUncertain, assistantRoute, beginAssistantSubmission, clearAssistantSessions, createAssistantMessageRequest, currentAssistantSession, failAssistantSubmission, initializeAssistantDraft, latestAssistantSuggestion, mergeAssistantHistory, sendingAssistantSubmission, subscribeAssistantSession, suggestedSettingsChanges, updateAssistantDraft} from '../src/lib/assistant.js';

const error = (status, code) => ({status, data: {error: {code}}});
const message = (id, revision, role = 'USER', suggestedSettings) => ({id, conversationRevision: revision, role, content: 'A saved message.', createdAt: '2026-11-21T12:00:00Z', ...(suggestedSettings ? {suggestedSettings} : {})});
const response = (data, status = 200) => new Response(JSON.stringify({data}), {status, headers: {'Content-Type': 'application/json'}});

test('assistant input respects Unicode limits and blocks obvious credentials before saving or sending', () => {
  assert.equal(assistantInputError('Explain the event loop to beginners.'), '');
  assert.equal(assistantInputError('🔍'.repeat(2000)), '');
  for (const input of ['', ' ', 'x'.repeat(2001), '\ud800', 'a\u0000b']) assert.ok(assistantInputError(input));
  for (const input of ['AIza' + 'x'.repeat(35), 'sk-' + 'x'.repeat(30), '-----BEGIN PRIVATE KEY-----']) assert.match(assistantInputError(input), /credential/u);
  assert.equal(assistantInputError('Explain how to keep API keys private and prevent phishing.'), '');
});

test('dashboard chat titles are bounded and routes encode opaque IDs', () => {
  assert.equal(assistantProjectTitle('  Explain\n  photosynthesis  '), 'Explain photosynthesis');
  assert.equal(Array.from(assistantProjectTitle('🌱'.repeat(150))).length, 90);
  assert.equal(assistantRoute('../other/project'), '/app/projects/..%2Fother%2Fproject/assistant');
});

test('saved history merges refreshes and later pages without optimistic duplicates or reordering', () => {
  const first = [message('u1', 1), message('a2', 2, 'ASSISTANT')];
  const next = [message('u3', 3), message('a4', 4, 'ASSISTANT')];
  assert.deepEqual(mergeAssistantHistory(next, first, first).map(item => item.id), ['u1', 'a2', 'u3', 'a4']);
  assert.equal(first.length, 2);
  assert.deepEqual(mergeAssistantHistory([{id: 'bad', role: 'SYSTEM', conversationRevision: 7}]), []);
});

test('only the latest assistant reply supplies proposals and all changes remain explicit', () => {
  assert.deepEqual(latestAssistantSuggestion([message('a1', 2, 'ASSISTANT', {durationSec: 60}), message('a2', 4, 'ASSISTANT')]), {});
  const current = {durationSec: 30, mode: 'FACELESS', language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'};
  assert.deepEqual(suggestedSettingsChanges(current, {durationSec: 60, language: 'en', characterAssetId: null}), {durationSec: 60});
  assert.equal(current.durationSec, 30);
  for (const proposal of [{durationSec: 120}, {language: 'hi'}, {mode: 'CHARACTER_2D'}, {ownerId: 'other'}, {aspectRatio: '9:16'}, []]) assert.equal(suggestedSettingsChanges(current, proposal), null);
  assert.deepEqual(suggestedSettingsChanges(current, {}), {});
});

test('draft seeding happens once and later history refreshes do not discard local text', () => {
  clearAssistantSessions(); const session = assistantDraftSession('owner', 'project');
  initializeAssistantDraft(session, 'Original saved idea');
  updateAssistantDraft(session, 'A locally edited question');
  initializeAssistantDraft(session, 'An unrelated refresh value');
  assert.equal(session.draft, 'A locally edited question');
  assert.equal(assistantDraftSession('owner', 'project'), session);
  assert.notEqual(assistantDraftSession('other', 'project'), session);
});

test('uncertain responses retain the frozen body and key, including replay-only not-found', () => {
  clearAssistantSessions(); const session = assistantDraftSession('owner', 'project'); updateAssistantDraft(session, 'What is the topic?');
  const first = beginAssistantSubmission(session, 0, () => 'original-key');
  sendingAssistantSubmission(session, first);
  failAssistantSubmission(session, first, {status: 'TIMEOUT_ERROR'});
  assert.equal(session.pending, first); assert.equal(first.inFlight, false); assert.equal(first.uncertain, true);
  updateAssistantDraft(session, 'A new unsent question');
  assert.equal(beginAssistantSubmission(session, 0, () => 'must-not-be-used'), first);
  failAssistantSubmission(session, first, error(404, 'ASSISTANT_REQUEST_NOT_FOUND'));
  assert.equal(session.pending.key, 'original-key'); assert.equal(session.pending.message, 'What is the topic?');
});

test('a saved receipt clears only its submitted text and preserves separately edited text', () => {
  clearAssistantSessions(); const session = assistantDraftSession('owner', 'project'); updateAssistantDraft(session, 'Submitted text');
  const pending = beginAssistantSubmission(session, 0, () => 'key-one'); updateAssistantDraft(session, 'A different unsent draft');
  assert.equal(acceptAssistantSubmission(session, pending, {conversationRevision: 2}), true);
  assert.equal(session.draft, 'A different unsent draft'); assert.equal(session.pending, null);
  const second = beginAssistantSubmission(session, 2, () => 'key-two'); acceptAssistantSubmission(session, second, {conversationRevision: 4});
  assert.equal(session.draft, ''); assert.equal(session.lastRevision, 4);
});

test('known provider failure or never-accepted project busy releases the next manual request key', () => {
  clearAssistantSessions(); const session = assistantDraftSession('owner', 'project'); updateAssistantDraft(session, 'A preserved idea');
  const pending = beginAssistantSubmission(session, 0, () => 'first'); failAssistantSubmission(session, pending, error(503, 'PROVIDER_UNAVAILABLE'));
  assert.equal(session.pending, null); assert.equal(session.draft, 'A preserved idea');
  const next = beginAssistantSubmission(session, 0, () => 'second'); assert.notEqual(next.key, pending.key);
  failAssistantSubmission(session, next, error(409, 'ASSISTANT_IN_PROGRESS')); assert.equal(session.pending, null);
});

test('privacy reset aborts outstanding work and rejects late responses from the previous account session', () => {
  clearAssistantSessions(); const session = assistantDraftSession('owner', 'project'); let updates = 0;
  const unsubscribe = subscribeAssistantSession(session, () => {updates++;}); updateAssistantDraft(session, 'Private local text');
  const pending = beginAssistantSubmission(session, 0, () => 'private-key'); clearAssistantSessions();
  assert.equal(pending.controller.signal.aborted, true); assert.equal(session.draft, ''); assert.equal(currentAssistantSession(session), false);
  assert.equal(acceptAssistantSubmission(session, pending, {conversationRevision: 2}), false);
  assert.equal(assistantDraftSession('owner', 'project').draft, ''); assert.ok(updates >= 3); unsubscribe();
});

test('same-user cache resets can reacquire a fresh draft while old subscribers are notified', () => {
  clearAssistantSessions(); const previous = assistantDraftSession('owner', 'project'); let replacement;
  updateAssistantDraft(previous, 'A private unsent message');
  const unsubscribe = subscribeAssistantSession(previous, () => {replacement = assistantDraftSession('owner', 'project');});
  clearAssistantSessions();
  assert.ok(replacement); assert.notEqual(replacement, previous); assert.equal(currentAssistantSession(replacement), true); assert.equal(replacement.draft, '');
  unsubscribe();
});

test('only ambiguous failures keep a possible accepted request and user messages remain safe', () => {
  for (const failure of [{status: 'FETCH_ERROR'}, error(500, 'INTERNAL_ERROR'), error(503, 'DATABASE_UNAVAILABLE'), error(409, 'ASSISTANT_REQUEST_IN_PROGRESS')]) assert.equal(assistantRequestUncertain(failure), true);
  for (const failure of [error(503, 'PROVIDER_UNAVAILABLE'), error(504, 'AI_TIMEOUT'), error(422, 'CONTENT_REJECTED'), error(409, 'ASSISTANT_REQUEST_EXPIRED'), error(409, 'ASSISTANT_IN_PROGRESS')]) assert.equal(assistantRequestUncertain(failure), false);
  assert.match(assistantError(error(503, 'PROVIDER_UNAVAILABLE')), /saved conversation/u);
  assert.match(assistantError(error(422, 'SENSITIVE_INPUT')), /credentials/u);
});

test('native assistant request uses CSRF, cookies, a stable key and only approved body fields', async () => {
  const calls = [];
  const request = createAssistantMessageRequest({locks: null, fetchImpl: async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('/csrf')) return response({csrfToken: 'csrf-proof'});
    return response({assistantMessage: 'What would you like to explain?', suggestedSettings: {}, missingInformation: ['What would you like to explain?'], conversationRevision: 2});
  }});
  const result = await request({projectId: 'project', message: 'My idea', idempotencyKey: 'request-one', ownerId: 'ignored', replayOnly: true});
  assert.equal(result.conversationRevision, 2);
  const call = calls.find(call => call.url.endsWith('/assistant/messages'));
  assert.deepEqual(JSON.parse(call.options.body), {projectId: 'project', message: 'My idea'});
  assert.equal(call.options.credentials, 'include'); assert.equal(call.options.headers.get('X-CSRF-Token'), 'csrf-proof');
  assert.equal(call.options.headers.get('Idempotency-Key'), 'request-one'); assert.equal(call.options.headers.get('X-Assistant-Replay-Only'), 'true');
  assert.equal(call.options.signal.aborted, false);
});

test('cookie renewal retries the same assistant request with the same identity once', async () => {
  let posts = 0, refreshes = 0;
  const keys = [];
  const request = createAssistantMessageRequest({locks: null, fetchImpl: async (url, options) => {
    if (url.endsWith('/csrf')) return response({csrfToken: 'proof'});
    if (url.endsWith('/auth/me')) return new Response(JSON.stringify({error: {code: 'AUTH_REQUIRED'}}), {status: 401});
    if (url.endsWith('/auth/refresh')) {refreshes++; return response({user: {id: 'owner'}});}
    posts++; keys.push(options.headers.get('Idempotency-Key'));
    return posts === 1 ? new Response(JSON.stringify({error: {code: 'AUTH_REQUIRED'}}), {status: 401}) : response({assistantMessage: 'Saved', suggestedSettings: {}, missingInformation: [], conversationRevision: 2});
  }});
  await request({projectId: 'project', message: 'Same message', idempotencyKey: 'one-key'});
  assert.equal(refreshes, 1); assert.equal(posts, 2); assert.deepEqual(keys, ['one-key', 'one-key']);
});

test('a replay-only missing receipt stays distinct from project deletion and never becomes a fresh send', async () => {
  let calls = 0;
  const request = createAssistantMessageRequest({locks: null, fetchImpl: async (url, options) => {
    if (url.endsWith('/csrf')) return response({csrfToken: 'proof'});
    calls++; assert.equal(options.headers.get('X-Assistant-Replay-Only'), 'true');
    return new Response(JSON.stringify({error: {code: 'ASSISTANT_REQUEST_NOT_FOUND', details: {requestAccepted: false}}}), {status: 404});
  }});
  await assert.rejects(() => request({projectId: 'project', message: 'An uncertain request', idempotencyKey: 'same-key', replayOnly: true}), failure => failure.status === 404 && failure.data.error.code === 'ASSISTANT_REQUEST_NOT_FOUND');
  assert.equal(calls, 1);
});
