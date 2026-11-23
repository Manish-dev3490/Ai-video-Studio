import test from 'node:test';
import assert from 'node:assert/strict';
import {codePoints, friendlyError, safeReturnPath, validateAuthForm} from '../src/lib/forms.js';

test('text-fit feedback distinguishes an overflowing label from unsupported flowchart connections', () => {
  assert.match(friendlyError({data: {error: {code: 'LAYOUT_REVIEW_REQUIRED', details: {profile: 'INTER_720P_MEASURED_ADVANCES'}}}}), /Shorten the visual label/u);
  assert.match(friendlyError({data: {error: {code: 'LAYOUT_REVIEW_REQUIRED', details: {profile: 'ORDERED_LINEAR_FLOWCHART'}}}}), /2–4 nodes/u);
});

test('signup enforces Unicode code-point password boundaries without trimming', () => {
  const base = {displayName: 'Studio User', email: 'user@example.com'};
  assert.equal(codePoints('😀'.repeat(15)), 15);
  assert.equal(validateAuthForm({...base, password: '😀'.repeat(15)}, 'signup').password, undefined);
  assert.equal(validateAuthForm({...base, password: ' '.repeat(15)}, 'signup').password, undefined);
  assert.ok(validateAuthForm({...base, password: 'x'.repeat(14)}, 'signup').password);
  assert.equal(validateAuthForm({...base, password: 'x'.repeat(128)}, 'signup').password, undefined);
  assert.ok(validateAuthForm({...base, password: 'x'.repeat(129)}, 'signup').password);
});

test('signup validates name and email and login does not require a signup-length password', () => {
  const errors = validateAuthForm({displayName: ' ', email: 'broken', password: ''}, 'signup');
  assert.deepEqual(Object.keys(errors), ['displayName', 'email', 'password']);
  assert.equal(validateAuthForm({email: 'user@example.com', password: 'a'}, 'login').password, undefined);
});

test('return paths remain inside the authenticated app', () => {
  assert.equal(safeReturnPath('/app/projects?view=all'), '/app/projects?view=all');
  for (const value of ['https://evil.example/app', '//evil.example/app', '/app/../../login', '/login', '/app\\evil', null]) assert.equal(safeReturnPath(value), '/app');
});

test('unknown server messages are not reflected into authentication UI', () => {
  assert.equal(friendlyError({status: 500, data: {error: {message: 'secret database exception'}}}), 'The studio could not complete this request. Saved projects are preserved. Please try again shortly.');
  assert.match(friendlyError({status: 401, data: {error: {code: 'INVALID_CREDENTIALS'}}}), /email or password/iu);
  assert.match(friendlyError({status: 409, data: {error: {code: 'EMAIL_UNAVAILABLE'}}}), /already exists/iu);
});

test('service and proxy errors do not blame a working browser connection or expose response content', () => {
  const network = friendlyError({status: 'FETCH_ERROR'});
  assert.match(network, /Check your connection/u);
  for (const error of [{status: 502}, {status: 504}, {status: 'PARSING_ERROR', originalStatus: 502, data: '<html>private gateway details</html>'}, {status: 'PARSING_ERROR', originalStatus: 504}, {status: 503}, {status: 'TIMEOUT_ERROR'}]) {
    const message = friendlyError(error);
    assert.notEqual(message, network); assert.ok(!message.includes('Check your connection')); assert.ok(!message.includes('private gateway details')); assert.match(message, /saved|Saved/u);
  }
  assert.match(friendlyError({status: 'PARSING_ERROR', originalStatus: 502}), /saved result/u);
  assert.match(friendlyError({status: 'TIMEOUT_ERROR'}), /too long/u);
});

test('known writing, database and interruption failures keep actionable safe messages', () => {
  for (const [code, pattern] of Object.entries({AI_RATE_LIMITED: /writing service is busy/u, AI_BUSY: /writing service is busy/u, REQUEST_ABORTED: /Check for a saved result/u, DATABASE_UNAVAILABLE: /temporarily unavailable/u, AI_CONTEXT_UNAVAILABLE: /Refresh the project/u})) {
    const message = friendlyError({status: 503, data: {error: {code, message: 'raw provider diagnostic'}}});
    assert.match(message, pattern); assert.ok(!message.includes('raw provider diagnostic')); assert.ok(!message.includes('Check your connection'));
  }
});
