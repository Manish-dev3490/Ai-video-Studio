import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAssistantRequest, idempotencyKey, historyQuery, publicAssistantMessage} from '../src/assistant/validation.js';
import {encodeAssistantCursor, decodeAssistantCursor} from '../src/assistant/cursors.js';

const ownerId = 'a'.repeat(24), projectId = 'b'.repeat(24);
const config = {csrfSecret: 'a private cursor test secret repeated safely'};
test('assistant input has a strict bounded Unicode contract and rejects actor injection', () => {
  assert.deepEqual(validateAssistantRequest({projectId, message: '  Explain the event loop.  '}), {projectId, message: 'Explain the event loop.'});
  assert.equal(Array.from(validateAssistantRequest({projectId, message: '🔑'.repeat(2000)}).message).length, 2000);
  for (const input of [{projectId, message: ''}, {projectId, message: 'x'.repeat(2001)}, {projectId, message: ' ' + 'x'.repeat(2000)}, {projectId, message: 'x'.repeat(2000) + ' '}, {projectId, message: '\ud800'}, {projectId, message: 'hello\u0000'}, {projectId, message: 'hello', ownerId}, {projectId, message: 'hello', role: 'ASSISTANT'}]) assert.throws(() => validateAssistantRequest(input), {status: 422});
  assert.throws(() => validateAssistantRequest({projectId: '../other', message: 'hello'}), {status: 404});
});
test('assistant keys accept UUIDs and history parameters never exceed the page bound', () => {
  assert.equal(idempotencyKey('b5d671a7-689c-4fe8-bf4e-a323fbc333c0'), 'b5d671a7-689c-4fe8-bf4e-a323fbc333c0');
  assert.match(idempotencyKey(), /^[a-f0-9-]{36}$/u);
  for (const key of ['', 'short', 'a'.repeat(129), 'header\ninjection']) assert.throws(() => idempotencyKey(key), {status: 422});
  assert.deepEqual(historyQuery({}), {limit: 20, cursor: undefined});
  assert.deepEqual(historyQuery({limit: '50'}), {limit: 50, cursor: undefined});
  for (const query of [{limit: '51'}, {limit: '1.5'}, {limit: '0'}, {limit: ['2']}, {cursor: ''}, {ownerId}]) assert.throws(() => historyQuery(query), {status: 400});
});
test('conversation cursors authenticate the owner/project scope and sequence', () => {
  const cursor = encodeAssistantCursor({ownerId, projectId, after: 20}, config);
  assert.equal(decodeAssistantCursor(cursor, {ownerId, projectId}, config), 20);
  for (const [value, scope] of [[cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'), {ownerId, projectId}], [cursor, {ownerId: 'c'.repeat(24), projectId}], [cursor, {ownerId, projectId: 'd'.repeat(24)}], ['not-a-cursor', {ownerId, projectId}]]) assert.throws(() => decodeAssistantCursor(value, scope, config), {status: 400});
});
test('history serializer returns only approved message fields', () => {
  const value = {_id: 'd'.repeat(24), role: 'ASSISTANT', content: 'Who is the audience?', conversationRevision: 2, createdAt: new Date('2026-11-21T00:00:00Z'), suggestedSettings: {durationSec: 60}, missingInformation: ['Who is the audience?'], providerPayload: {secret: 'never public'}, ownerId};
  assert.deepEqual(Object.keys(publicAssistantMessage(value)).sort(), ['content', 'conversationRevision', 'createdAt', 'id', 'role', 'suggestedSettings']);
  assert.equal(JSON.stringify(publicAssistantMessage(value)).includes('providerPayload'), false);
  assert.equal(JSON.stringify(publicAssistantMessage(value)).includes('missingInformation'), false);
  assert.equal(Object.hasOwn(publicAssistantMessage({...value, role: 'USER'}), 'suggestedSettings'), false);
});
