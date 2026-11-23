import test from 'node:test';
import assert from 'node:assert/strict';
import {admissionReceipt, publicGeneration, idempotencyKey, strictBody, encodeGenerationCursor, decodeGenerationCursor} from '../src/jobs/contracts.js';

const owner = '111111111111111111111111';
const projectId = '222222222222222222222222';
const fixture = {_id: '333333333333333333333333', ownerId: owner, projectId, storyboardId: '444444444444444444444444', approvedRevision: 2, status: 'QUEUED', stage: null, progress: {completedStages: 0, totalStages: 6}, attempt: 0, outputAssetId: null, captionAssetId: null, error: null, lease: {secret: 'private-fence'}, snapshot: {private: true}, createdAt: new Date('2026-11-21T12:00:00Z'), updatedAt: new Date('2026-11-21T12:00:00Z')};

test('public generation and immutable admission receipt never leak worker fields', () => {
  const data = publicGeneration(fixture);
  assert.deepEqual(Object.keys(data).sort(), ['approvedRevision', 'attempt', 'captionAssetId', 'createdAt', 'error', 'id', 'outputAssetId', 'progress', 'projectId', 'stage', 'status', 'storyboardId', 'updatedAt']);
  assert.equal(JSON.stringify(data).includes('private-fence'), false);
  assert.deepEqual(admissionReceipt(fixture), {generationId: fixture._id, projectId, storyboardId: fixture.storyboardId, approvedRevision: 2, status: 'QUEUED', stage: null, statusUrl: '/api/v1/generations/' + fixture._id});
});
test('idempotency key is bounded, hashed and rejects controls', () => {
  assert.match(idempotencyKey('one-user-request-123'), /^[a-f0-9]{64}$/u);
  for (const value of [undefined, 'short', 'x'.repeat(201), 'line\nbreak']) assert.throws(() => idempotencyKey(value), {code: 'IDEMPOTENCY_KEY_REQUIRED'});
  assert.equal(idempotencyKey('same-key-123'), idempotencyKey('same-key-123'));
});
test('strict generation requests reject unknown server-managed properties', () => {
  strictBody({storyboardId: fixture.storyboardId, approvedRevision: 2}, ['storyboardId', 'approvedRevision']);
  assert.throws(() => strictBody({storyboardId: fixture.storyboardId, approvedRevision: 2, ownerId: owner}, ['storyboardId', 'approvedRevision']), {code: 'VALIDATION_FAILED'});
});
test('generation history cursors bind owner/project and detect tampering', () => {
  const secret = 'cursor-test-secret-which-is-not-a-credential';
  const cursor = encodeGenerationCursor(fixture, owner, secret);
  assert.equal(decodeGenerationCursor(cursor, owner, projectId, secret).id, fixture._id);
  for (const [value, user, project] of [[cursor + 'x', owner, projectId], [cursor, fixture._id, projectId], [cursor, owner, fixture._id], ['', owner, projectId]]) assert.throws(() => decodeGenerationCursor(value, user, project, secret), {code: 'INVALID_QUERY'});
});
