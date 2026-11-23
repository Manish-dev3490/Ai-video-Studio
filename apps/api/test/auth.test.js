import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {COOKIE_NAMES, parseRefreshToken} from '../src/security.js';
import {createMemoryRepository} from './helpers/memory-repository.js';

const password = 'correct horse battery staple';
const configFor = extra => ({...loadConfig({NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/avs_phase3_test_only', APP_ORIGIN: 'http://127.0.0.1:5173', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)}), authRateLimit: 100, ...extra});

async function fixture(t, extra = {}) {
  const repository = createMemoryRepository();
  let time = Date.now();
  const config = configFor(extra);
  const app = createApp({config, repository, now: () => time});
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookies = new Map();
  const request = async (route, {method = 'GET', body, headers = {}, cookieOverride, csrf = true} = {}) => {
    const response = await fetch(origin + '/api/v1' + route, {method, headers: {...(method === 'GET' ? {} : {'Origin': config.appOrigin, 'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': decodeURIComponent(cookies.get(COOKIE_NAMES.csrf) || '')} : {})}), ...(cookieOverride !== undefined ? {Cookie: cookieOverride} : cookies.size ? {Cookie: [...cookies].map(([name, value]) => name + '=' + value).join('; ')} : {}), ...headers}, ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})});
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator), value = pair.slice(separator + 1);
      if (!value) cookies.delete(name); else cookies.set(name, value);
    }
    const text = await response.text();
    return {status: response.status, headers: response.headers, cookies: response.headers.getSetCookie(), body: text ? JSON.parse(text) : null};
  };
  const bootstrap = () => request('/auth/csrf');
  const signup = input => request('/auth/signup', {method: 'POST', body: {displayName: 'Demo User', email: 'demo@example.test', password, ...input}});
  return {repository, config, cookies, request, bootstrap, signup, advance: delta => { time += delta; }};
}

test('signup establishes cookie-only session and returns exactly the public user DTO', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/auth/me')).status, 401);
  const bootstrap = await f.bootstrap();
  assert.ok(bootstrap.body.data.csrfToken);
  const result = await f.signup({email: ' DEMO@Example.test '});
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'meta']);
  assert.deepEqual(Object.keys(result.body.data.user).sort(), ['displayName', 'email', 'id']);
  assert.equal(result.body.data.user.email, 'demo@example.test');
  assert.ok(result.body.meta.requestId);
  assert.ok(result.cookies.length === 2);
  for (const line of result.cookies) { assert.match(line, /HttpOnly/u); assert.match(line, /SameSite=Lax/u); }
  assert.ok(result.cookies.find(line => line.startsWith('avs_refresh=')).includes('Path=/api/v1/auth'));
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal((await f.request('/auth/me')).status, 200);
  const stored = [...f.repository.users.values()][0];
  assert.match(stored.passwordHash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u);
  assert.equal(JSON.stringify(result.body).includes(stored.passwordHash), false);
  const session = [...f.repository.sessions.values()][0];
  assert.match(session.tokenHash, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(session).includes(decodeURIComponent(f.cookies.get(COOKIE_NAMES.refresh))), false);
});

test('CSRF bootstrap reuses a valid binding and mutations require exact Origin plus token', async t => {
  const f = await fixture(t);
  const first = await f.bootstrap();
  const second = await f.bootstrap();
  assert.equal(first.body.data.csrfToken, second.body.data.csrfToken);
  assert.equal((await f.request('/auth/signup', {method: 'POST', body: {}, headers: {Origin: 'https://attacker.example'}})).body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal((await f.request('/auth/signup', {method: 'POST', body: {}, headers: {Origin: ''}})).body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal((await f.request('/auth/signup', {method: 'POST', body: {}, csrf: false})).body.error.code, 'CSRF_INVALID');
  assert.equal((await f.request('/auth/signup', {method: 'POST', body: {}, headers: {'X-CSRF-Token': 'guessed'}})).status, 403);
  const crossSite = await f.request('/auth/csrf', {headers: {'Sec-Fetch-Site': 'cross-site'}});
  assert.equal(crossSite.status, 403);
  assert.equal(f.repository.users.size, 0);
});

test('strict validation preserves full Unicode passwords and never accepts extra roles', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  for (const invalid of [{password: 'x'.repeat(14)}, {password: 'x'.repeat(129)}, {password: '\ud800'.repeat(16)}, {role: 'ADMIN'}, {displayName: 'X'}, {displayName: 'x'.repeat(81)}]) {
    const result = await f.signup(invalid);
    assert.equal(result.status, 422);
    assert.ok(result.body.error.details && !Array.isArray(result.body.error.details));
    assert.ok(result.body.error.details.fields.length <= 3);
  }
  const unicode = '🔑'.repeat(128);
  assert.equal((await f.signup({password: unicode})).status, 201);
  assert.equal((await f.request('/auth/logout', {method: 'POST', body: {}})).status, 204);
  const login = await f.request('/auth/login', {method: 'POST', body: {email: 'demo@example.test', password: unicode}});
  assert.equal(login.status, 200);
  assert.equal((await f.request('/auth/login', {method: 'POST', body: {email: 'demo@example.test', password: unicode.slice(0, -2) + 'a'}})).status, 401);
});

test('invalid login is generic for missing, wrong-password and suspended users', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const wrong = await f.request('/auth/login', {method: 'POST', body: {email: 'demo@example.test', password: 'incorrect password'}});
  const missing = await f.request('/auth/login', {method: 'POST', body: {email: 'missing@example.test', password}});
  [...f.repository.users.values()][0].status = 'SUSPENDED';
  const suspended = await f.request('/auth/login', {method: 'POST', body: {email: 'demo@example.test', password}});
  assert.deepEqual(wrong.body.error, missing.body.error);
  assert.deepEqual(wrong.body.error, suspended.body.error);
  assert.equal((await f.request('/auth/me')).status, 401);
});

test('access expiry refreshes once, rotates the secret atomically and replay revokes the family', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const previousRefresh = f.cookies.get(COOKIE_NAMES.refresh);
  const csrfCookie = f.cookies.get(COOKIE_NAMES.csrf);
  f.advance(901000);
  assert.equal((await f.request('/auth/me')).status, 401);
  const refresh = await f.request('/auth/refresh', {method: 'POST', body: {}});
  assert.equal(refresh.status, 200);
  const rotatedRefresh = f.cookies.get(COOKIE_NAMES.refresh);
  const rotatedAccess = f.cookies.get(COOKIE_NAMES.access);
  assert.notEqual(rotatedRefresh, previousRefresh);
  assert.equal((await f.request('/auth/me')).status, 200);
  const replay = await f.request('/auth/refresh', {method: 'POST', body: {}, cookieOverride: `avs_refresh=${previousRefresh}; avs_csrf=${csrfCookie}`});
  assert.equal(replay.status, 401);
  assert.equal((await f.request('/auth/me', {cookieOverride: `avs_access=${rotatedAccess}`})).status, 401);
  assert.ok([...f.repository.sessions.values()][0].revokedAt);
});

test('unknown refresh guesses cannot revoke a valid logical session', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const access = f.cookies.get(COOKIE_NAMES.access);
  const parsed = parseRefreshToken(decodeURIComponent(f.cookies.get(COOKIE_NAMES.refresh)));
  const guessed = parsed.sessionId + '.' + 'x'.repeat(43);
  const result = await f.request('/auth/refresh', {method: 'POST', body: {}, cookieOverride: `avs_refresh=${guessed}; avs_csrf=${f.cookies.get(COOKIE_NAMES.csrf)}`});
  assert.equal(result.status, 401);
  assert.equal([...f.repository.sessions.values()][0].revokedAt, null);
  assert.equal((await f.request('/auth/me', {cookieOverride: `avs_access=${access}`})).status, 200);
});

test('concurrent refresh CAS loser revokes the stable record without resurrection', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const refresh = f.cookies.get(COOKIE_NAMES.refresh), csrf = f.cookies.get(COOKIE_NAMES.csrf);
  const options = {method: 'POST', body: {}, cookieOverride: `avs_refresh=${refresh}; avs_csrf=${csrf}`};
  const results = await Promise.all([f.request('/auth/refresh', options), f.request('/auth/refresh', options)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  assert.equal(f.repository.sessions.size, 1);
  assert.ok([...f.repository.sessions.values()][0].revokedAt);
  const winner = results.find(result => result.status === 200);
  const access = winner.cookies.find(line => line.startsWith('avs_access=')).split(';')[0];
  assert.equal((await f.request('/auth/me', {cookieOverride: access})).status, 401);
});

test('logout revokes access immediately and clears both auth cookie paths', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const access = f.cookies.get(COOKIE_NAMES.access);
  const result = await f.request('/auth/logout', {method: 'POST', body: {}});
  assert.equal(result.status, 204);
  assert.equal(result.body, null);
  assert.equal(result.cookies.length, 2);
  assert.ok(result.cookies.every(line => line.includes('Expires=Thu, 01 Jan 1970')));
  assert.equal((await f.request('/auth/me', {cookieOverride: `avs_access=${access}`})).status, 401);
});

test('logout still revokes a verified access session when the refresh cookie is missing', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const access = f.cookies.get(COOKIE_NAMES.access);
  f.cookies.delete(COOKIE_NAMES.refresh);
  assert.equal((await f.request('/auth/logout', {method: 'POST', body: {}})).status, 204);
  assert.equal((await f.request('/auth/me', {cookieOverride: `avs_access=${access}`})).status, 401);
});

test('session expiry and history cap require new login independently of TTL cleanup', async t => {
  const f = await fixture(t);
  await f.bootstrap();
  await f.signup();
  const session = [...f.repository.sessions.values()][0];
  session.rotationCount = 2048;
  assert.equal((await f.request('/auth/refresh', {method: 'POST', body: {}})).status, 401);
  assert.ok(session.revokedAt);
  await f.request('/auth/login', {method: 'POST', body: {email: 'demo@example.test', password}});
  f.advance(604800001);
  await f.bootstrap();
  assert.equal((await f.request('/auth/refresh', {method: 'POST', body: {}})).status, 401);
  assert.equal((await f.request('/auth/me')).status, 401);
});

test('malformed/oversized requests are sanitized and auth rate limiting returns Retry-After', async t => {
  const f = await fixture(t, {authRateLimit: 2});
  await f.bootstrap();
  const malformed = await f.request('/auth/signup', {method: 'POST', body: '{"password":"do-not-echo-this"'});
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'INVALID_JSON');
  assert.equal(JSON.stringify(malformed.body).includes('do-not-echo-this'), false);
  const wrongType = await f.request('/auth/signup', {method: 'POST', body: '{}', headers: {'Content-Type': 'text/plain'}});
  assert.equal(wrongType.status, 415);
  const large = await f.request('/auth/signup', {method: 'POST', body: {password: 'x'.repeat(17000)}});
  assert.equal(large.status, 413);
  await f.request('/auth/login', {method: 'POST', body: {}});
  await f.request('/auth/login', {method: 'POST', body: {}});
  const limited = await f.request('/auth/login', {method: 'POST', body: {}});
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('Retry-After'));
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
});

test('production cookies are Secure and config rejects unsafe secrets/deployment origins', async t => {
  assert.throws(() => loadConfig({MONGODB_URI: 'mongodb://localhost/test'}));
  assert.throws(() => loadConfig({NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost/test', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64), APP_ORIGIN: 'http://127.0.0.1:5173'}));
  const f = await fixture(t, {isProduction: true, appOrigin: 'https://studio.example.test'});
  const csrf = await f.bootstrap();
  assert.ok(csrf.cookies.every(line => line.includes('Secure')));
  const result = await f.signup();
  assert.equal(result.status, 201);
  assert.ok(result.cookies.every(line => line.includes('Secure')));
});
