import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {COOKIE_NAMES} from '../src/security.js';
import {createMemoryRepository} from './helpers/memory-repository.js';
import {actionToken, displayName, email, password, strictObject} from '../src/account/validation.js';
import {actionTokenHash, epochFilter} from '../src/account/service.js';

test('account validation uses strict fields, Unicode password policy and purpose-bound token hashes', () => {
  assert.equal(displayName('  E\u0301mma  '), 'Émma');
  assert.equal(email(' Person@Example.test '), 'person@example.test');
  assert.equal(password('🔑'.repeat(15)), '🔑'.repeat(15));
  assert.throws(() => password('x'.repeat(14)), {code: 'VALIDATION_FAILED'});
  assert.throws(() => password('\ud800'.repeat(15)), {code: 'VALIDATION_FAILED'});
  assert.throws(() => displayName('X'), {code: 'VALIDATION_FAILED'});
  assert.throws(() => email('a<injection>@example.test'), {code: 'VALIDATION_FAILED'});
  assert.throws(() => strictObject({displayName: 'Demo', role: 'ADMIN'}, ['displayName']), {code: 'VALIDATION_FAILED'});
  assert.throws(() => actionToken('guessed'), {code: 'INVALID_ACTION_LINK'});
  const token = 'a'.repeat(24) + '.' + 'b'.repeat(43);
  assert.equal(actionToken(token).id, 'a'.repeat(24));
  const config = {jwtSecret: 'fixture-secret-only'.repeat(4)};
  assert.notEqual(actionTokenHash(token, 'VERIFY_EMAIL', config), actionTokenHash(token, 'RESET_PASSWORD', config));
  assert.deepEqual(epochFilter(0), {$or: [{authVersion: 0}, {authVersion: {$exists: false}}]});
  assert.deepEqual(epochFilter(2), {authVersion: 2});
});

test('auth epoch invalidates old and late-created sessions while legacy epoch-zero sessions stay usable', async t => {
  const config = {...loadConfig({NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/epoch_fixture_only', APP_ORIGIN: 'http://127.0.0.1:5173', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)}), authRateLimit: 100};
  const repository = createMemoryRepository();
  const server = createServer(createApp({config, repository}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  async function request(route, method = 'GET', body) {
    const response = await fetch(origin + '/api/v1' + route, {method, headers: {...(method === 'GET' ? {} : {'Origin': config.appOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(cookies.get(COOKIE_NAMES.csrf) || '')}), Cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ')}, ...(body ? {body: JSON.stringify(body)} : {})});
    for (const line of response.headers.getSetCookie()) {const pair = line.split(';')[0], separator = pair.indexOf('='); const key = pair.slice(0, separator), value = pair.slice(separator + 1); if (value) cookies.set(key, value); else cookies.delete(key);}
    await response.text(); return response.status;
  }
  await request('/auth/csrf');
  assert.equal(await request('/auth/signup', 'POST', {displayName: 'Epoch Test', email: 'epoch@example.test', password: 'A private password for epoch tests.'}), 201);
  const user = [...repository.users.values()][0];
  const session = [...repository.sessions.values()][0];
  delete user.authVersion; delete session.authVersion;
  assert.equal(await request('/auth/me'), 200, 'Legacy missing versions normalize to zero');
  user.authVersion = 1;
  assert.equal(await request('/auth/me'), 401, 'Late/old epoch-zero session cannot authorize after a reset');
  assert.equal(await request('/auth/refresh', 'POST', {}), 401, 'Refresh cannot resurrect an old epoch');
  assert.ok(session.revokedAt);
});
