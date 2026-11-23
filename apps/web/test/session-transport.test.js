import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionTransport} from '../src/lib/session-transport.js';

const unauthorized = () => ({error: {status: 401, data: {error: {code: 'AUTH_REQUIRED'}}}});
const success = data => ({data: {data, meta: {requestId: 'req_test'}}});
const urlOf = args => typeof args === 'string' ? args : args.url;

test('CSRF bootstraps before signup; password is forwarded exactly and auth401 is never refreshed', async () => {
  const calls = [];
  const password = '  secret passphrase  ';
  const request = async args => {
    calls.push(args);
    if (urlOf(args) === '/auth/csrf') return success({csrfToken: 'proof'});
    assert.equal(args.headers.get('X-CSRF-Token'), 'proof');
    assert.equal(args.body.password, password);
    return unauthorized();
  };
  const transport = createSessionTransport(request, {locks: null});
  const result = await transport({url: '/auth/signup', method: 'POST', body: {password}});
  assert.equal(result.error.status, 401);
  assert.deepEqual(calls.map(urlOf), ['/auth/csrf', '/auth/signup']);
});

test('a stale CSRF proof is bootstrapped and retried at most once', async () => {
  let bootstraps = 0, writes = 0;
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/csrf') { bootstraps++; return success({csrfToken: 'proof-' + bootstraps}); }
    writes++;
    return {error: {status: 403, data: {error: {code: 'CSRF_INVALID'}}}};
  }, {locks: null});
  assert.equal((await transport({url: '/auth/login', method: 'POST', body: {}})).error.status, 403);
  assert.equal(bootstraps, 2);
  assert.equal(writes, 2);
});

test('Origin rejection is not retried as a CSRF or session failure', async () => {
  let writes = 0;
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/csrf') return success({csrfToken: 'proof'});
    writes++;
    return {error: {status: 403, data: {error: {code: 'ORIGIN_FORBIDDEN'}}}};
  }, {locks: null});
  await transport({url: '/auth/login', method: 'POST'});
  assert.equal(writes, 1);
});

test('concurrent protected401s share one refresh and retry after cookie renewal', async () => {
  let authenticated = false, refreshes = 0;
  const transport = createSessionTransport(async args => {
    const url = urlOf(args);
    if (url === '/auth/csrf') return success({csrfToken: 'proof'});
    if (url === '/auth/refresh') { refreshes++; await new Promise(resolve => setTimeout(resolve, 15)); authenticated = true; return success({user: {id: 'user_1'}}); }
    return authenticated ? success({ok: true}) : unauthorized();
  }, {locks: null});
  const result = await Promise.all(['/projects', '/usage', '/capabilities'].map(url => transport(url)));
  assert.ok(result.every(value => !value.error));
  assert.equal(refreshes, 1);
});

test('another tab renewal is rechecked under the shared Web Lock before rotating again', async () => {
  let authenticated = false, refreshes = 0;
  const locks = {request: async (name, work) => { assert.equal(name, 'avs-session-refresh'); authenticated = true; return work(); }};
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/refresh') refreshes++;
    return authenticated ? success({user: {id: 'user_1'}}) : unauthorized();
  }, {locks});
  assert.ok(!(await transport('/projects')).error);
  assert.equal(refreshes, 0);
});

test('a refresh outage preserves a retryable service error instead of reporting signed-out', async () => {
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/csrf') return success({csrfToken: 'proof'});
    if (urlOf(args) === '/auth/refresh') return {error: {status: 503, data: {error: {code: 'SERVICE_UNAVAILABLE'}}}};
    return unauthorized();
  }, {locks: null});
  assert.equal((await transport('/auth/me')).error.status, 503);
});

test('a rejected refresh returns401 without recursively refreshing', async () => {
  let refreshes = 0;
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/csrf') return success({csrfToken: 'proof'});
    if (urlOf(args) === '/auth/refresh') refreshes++;
    return unauthorized();
  }, {locks: null});
  assert.equal((await transport('/projects')).error.status, 401);
  assert.equal(refreshes, 1);
});

test('successful auth writes discard the old in-memory CSRF proof', async () => {
  let bootstraps = 0;
  const transport = createSessionTransport(async args => {
    if (urlOf(args) === '/auth/csrf') { bootstraps++; return success({csrfToken: 'proof-' + bootstraps}); }
    return success({user: {id: 'user_1'}});
  }, {locks: null});
  await transport({url: '/auth/login', method: 'POST', body: {}});
  await transport({url: '/auth/logout', method: 'POST', body: {}});
  assert.equal(bootstraps, 2);
});
