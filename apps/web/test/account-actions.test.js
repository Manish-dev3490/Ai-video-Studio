import test from 'node:test';
import assert from 'node:assert/strict';
import {accountError, actionTokenFromFragment, captureActionLocation, createAccountActionRequest, emailAddressError, profileNameError, recoveryPasswordErrors, scrubActionLocation} from '../src/lib/account-actions.js';

const token = 'a'.repeat(24) + '.' + 'b'.repeat(43);
const response = (status, data, headers = {}) => new Response(status === 204 ? null : JSON.stringify(status < 400 ? {data} : {error: data}), {status, headers: {'Content-Type': 'application/json', ...headers}});

test('only one well-formed action token is captured from a fragment', () => {
  assert.equal(actionTokenFromFragment('#token=' + token), token);
  for (const fragment of ['', '#token=guess', '#token=' + token + '&token=' + token, '#token=' + 'a'.repeat(100000), '#next=https://evil.example']) assert.equal(actionTokenFromFragment(fragment), null);
});

test('token scrubbing removes fragments and query credentials without replacing router state', () => {
  const state = {key: 'router-key', idx: 2};
  const calls = [];
  const history = {state, replaceState: (...args) => calls.push(args)};
  scrubActionLocation({pathname: '/reset-password', search: '?view=reset&token=' + token, hash: '#token=' + token}, history);
  assert.deepEqual(calls, [[state, '', '/reset-password?view=reset']]);
  calls.length = 0;
  scrubActionLocation({pathname: '/reset-password', search: '', hash: ''}, history);
  assert.equal(calls.length, 0);
});

test('recovery password rules preserve Unicode and whitespace and require exact confirmation', () => {
  assert.deepEqual(recoveryPasswordErrors('😀'.repeat(15), '😀'.repeat(15)), {});
  assert.deepEqual(recoveryPasswordErrors(' '.repeat(15), ' '.repeat(15)), {});
  assert.deepEqual(recoveryPasswordErrors('x'.repeat(128), 'x'.repeat(128)), {});
  assert.ok(recoveryPasswordErrors('x'.repeat(14), 'x'.repeat(14)).password);
  assert.ok(recoveryPasswordErrors('x'.repeat(129), 'x'.repeat(129)).password);
  assert.ok(recoveryPasswordErrors('\ud800'.repeat(16), '\ud800'.repeat(16)).password);
  assert.ok(recoveryPasswordErrors('   long passphrase   ', 'long passphrase').confirmation);
});

test('fresh same-route links replace the captured token while duplicate scrubbed events do not clear it', () => {
  const location = {pathname: '/reset-password', search: '', hash: '#token=' + token};
  const history = {state: {key: 'same-entry'}, replaceState: (state, title, relative) => {
    const next = new URL(relative, 'https://studio.test');
    Object.assign(location, {pathname: next.pathname, search: next.search, hash: next.hash});
  }};
  let capturedToken;
  const capture = () => {const result = captureActionLocation(location, history); if (result.present) capturedToken = result.token;};
  capture(); assert.equal(capturedToken, token); assert.equal(location.hash, '');
  capture(); assert.equal(capturedToken, token); // StrictMode/duplicate event.
  const fresh = 'c'.repeat(24) + '.' + 'd'.repeat(43);
  location.hash = '#token=' + fresh;
  capture(); assert.equal(capturedToken, fresh); assert.equal(location.hash, '');
  capture(); assert.equal(capturedToken, fresh);
  location.hash = '#token=malformed';
  capture(); assert.equal(capturedToken, null); assert.equal(location.hash, '');
});

test('profile names use normalized character bounds and reject controls; email input is bounded', () => {
  assert.equal(profileNameError('  Studio User  '), '');
  assert.equal(profileNameError('e\u0301e\u0301'), '');
  assert.ok(profileNameError('e\u0301'));
  assert.ok(profileNameError('a\nb'));
  assert.ok(profileNameError('\ud800x'));
  assert.ok(profileNameError('x'.repeat(81)));
  assert.equal(emailAddressError(' USER@example.test '), '');
  assert.ok(emailAddressError('user\r\n@example.test'));
  assert.ok(emailAddressError('missing-domain'));
  assert.ok(emailAddressError('<user>@example.test'));
  assert.ok(emailAddressError('user@example.test>'));
});

test('secret action POST uses cookies/CSRF but never puts its token into a URL', async () => {
  const calls = [];
  const password = '  New passphrase with spaces.  ';
  const action = createAccountActionRequest({locks: null, fetchImpl: async (url, options) => {
    calls.push({url, options});
    return url.endsWith('/csrf') ? response(200, {csrfToken: 'csrf-proof'}) : response(200, {status: 'PASSWORD_RESET'});
  }});
  assert.deepEqual(await action('/auth/reset-password', {token, password}), {status: 'PASSWORD_RESET'});
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/auth/csrf', '/api/v1/auth/reset-password']);
  assert.ok(calls.every(call => call.options.credentials === 'include' && !call.url.includes(token)));
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'csrf-proof');
  assert.deepEqual(JSON.parse(calls[1].options.body), {token, password});
});

test('public recovery rejection never starts an authentication refresh', async () => {
  for (const route of ['/auth/forgot-password', '/auth/reset-password', '/auth/verify-email', '/auth/confirm-email-change']) {
    const calls = [];
    const action = createAccountActionRequest({locks: null, fetchImpl: async url => {
      calls.push(url);
      return url.endsWith('/csrf') ? response(200, {csrfToken: 'proof'}) : response(401, {code: 'AUTH_REQUIRED'});
    }});
    await assert.rejects(action(route, {token}), error => error.status === 401);
    assert.deepEqual(calls, ['/api/v1/auth/csrf', '/api/v1' + route]);
  }
});

test('authenticated verification resend renews an expired cookie once before retrying', async () => {
  let authenticated = false, writes = 0, refreshes = 0, bootstraps = 0;
  const action = createAccountActionRequest({locks: null, fetchImpl: async url => {
    if (url.endsWith('/csrf')) return response(200, {csrfToken: 'proof-' + ++bootstraps});
    if (url.endsWith('/refresh')) {refreshes++; authenticated = true; return response(200, {user: {id: 'owner'}});}
    if (url.endsWith('/me')) return response(401, {code: 'AUTH_REQUIRED'});
    writes++;
    return authenticated ? response(202, {status: 'ACCEPTED'}) : response(401, {code: 'AUTH_REQUIRED'});
  }});
  assert.deepEqual(await action('/auth/request-email-verification'), {status: 'ACCEPTED'});
  assert.equal(refreshes, 1); assert.equal(writes, 2); assert.equal(bootstraps, 2);
});

test('step-up failure is not refreshed and Retry-After is preserved for email cooldown', async () => {
  let calls = 0;
  const action = createAccountActionRequest({locks: null, fetchImpl: async url => {
    if (url.endsWith('/csrf')) return response(200, {csrfToken: 'proof'});
    calls++;
    return calls === 1 ? response(403, {code: 'INVALID_CREDENTIALS'}) : response(429, {code: 'RATE_LIMITED'}, {'Retry-After': '42'});
  }});
  await assert.rejects(action('/account/email-change', {currentPassword: 'incorrect'}), error => error.status === 403);
  await assert.rejects(action('/account/email-change', {currentPassword: 'correct'}), error => error.retryAfter === 42);
  assert.equal(calls, 2);
});

test('only fixed same-origin action endpoints and intended methods are permitted', async () => {
  let calls = 0;
  const action = createAccountActionRequest({fetchImpl: async () => {calls++; throw new Error('unexpected request');}});
  for (const url of ['https://evil.example', '//evil.example', '/auth/reset-password?token=' + token, '/projects']) await assert.rejects(action(url, {token}), /Unsupported account action/u);
  await assert.rejects(action('/auth/verify-email', {token}, 'DELETE'), /Unsupported account action/u);
  assert.equal(calls, 0);
});

test('account UI errors do not disclose server text or confuse unavailable delivery with account collisions', () => {
  assert.match(accountError({status: 503, data: {error: {code: 'EMAIL_UNAVAILABLE'}}}), /delivery is unavailable/iu);
  assert.match(accountError({status: 422, data: {error: {code: 'INVALID_ACTION_LINK'}}}), /expired or already used/iu);
  assert.match(accountError({status: 403, data: {error: {code: 'INVALID_CREDENTIALS'}}}), /current password/iu);
  assert.match(accountError({status: 403, data: {error: {code: 'CURRENT_PASSWORD_INCORRECT'}}}), /current password/iu);
  assert.equal(accountError({status: 400, data: {error: {message: token}}}, 'Safe message'), 'Safe message');
});

test('network failures discard exception details that could contain a secret', async () => {
  const action = createAccountActionRequest({locks: null, fetchImpl: async () => {throw new Error(token);}});
  await assert.rejects(action('/auth/verify-email', {token}), error => error.status === 'FETCH_ERROR' && !JSON.stringify(error).includes(token));
});
