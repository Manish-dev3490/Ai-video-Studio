import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {loadConfig} from '../src/config.js';
import {createApp} from '../src/app.js';
import {assessProductionRuntime, createReadinessCheck, localProductionOrigin, requestMetadataLogger} from '../src/production-runtime.js';
import {createMemoryRepository} from './helpers/memory-repository.js';

const environment = {NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:5173', MONGODB_URI: 'mongodb://127.0.0.1/production_runtime_fixture', JWT_SECRET: 'j'.repeat(48), CSRF_SECRET: 'c'.repeat(48)};
const config = extra => loadConfig({...environment, ...extra});
async function listen(t, app) {
  const server = await new Promise(resolve => {const instance = app.listen(0, '127.0.0.1', () => resolve(instance));});
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
const production = extra => config({NODE_ENV: 'production', APP_ORIGIN: 'https://studio.localhost:8443', TRUST_PROXY: 'loopback', ENFORCE_HTTPS: 'true', MAIL_TRANSPORT: 'disabled', MAIL_ENCRYPTION_SECRET: 'm'.repeat(48), ...extra});

test('proxy trust is opt-in, exact, and tied to a loopback listener', () => {
  assert.equal(config().trustProxy, false); assert.equal(config().enforceHttps, false); assert.equal(config().requestLogging, false);
  assert.equal(production().requestLogging, true);
  assert.equal(production({ENFORCE_HTTPS: undefined}).enforceHttps, true, 'Production refuses plaintext by default even when the flag is omitted');
  for (const value of ['true', '1', '*', 'uniquelocal', 'loopback,uniquelocal']) assert.throws(() => config({TRUST_PROXY: value}));
  assert.throws(() => production({API_HOST: '0.0.0.0'}));
  assert.throws(() => config({ENFORCE_HTTPS: 'yes'}));
  assert.throws(() => config({REQUEST_LOGGING: '1'}));
  assert.throws(() => config({ENFORCE_HTTPS: 'true'}));
});

test('plaintext requests cannot spoof HTTPS without explicit trusted loopback proxy mode', async t => {
  const settings = {...production(), trustProxy: false, requestLogging: false};
  const app = createApp({config: settings, repository: createMemoryRepository(), readinessCheck: async () => true});
  const url = await listen(t, app);
  const denied = await fetch(url + '/api/v1/auth/csrf', {headers: {'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Host': 'evil.example'}});
  assert.equal(denied.status, 426); assert.equal((await denied.json()).error.code, 'HTTPS_REQUIRED');
  assert.equal(denied.headers.get('set-cookie'), null);
  assert.equal((await fetch(url + '/api/v1/health')).status, 200);
  assert.equal((await fetch(url + '/api/v1/ready')).status, 200);
  assert.equal((await fetch(url + '/api/v1/health', {method: 'POST'})).status, 426);
});

test('the explicit local proxy recognizes HTTPS, denies HTTP and trusts no remote proxy addresses', async t => {
  const app = createApp({config: {...production(), requestLogging: false}, repository: createMemoryRepository()});
  const trust = app.get('trust proxy fn');
  assert.equal(trust('127.0.0.1'), true); assert.equal(trust('::1'), true); assert.equal(trust('198.51.100.9'), false); assert.equal(trust('10.0.0.1'), false);
  const url = await listen(t, app);
  assert.equal((await fetch(url + '/api/v1/auth/csrf', {headers: {'X-Forwarded-Proto': 'http'}})).status, 426);
  const response = await fetch(url + '/api/v1/auth/csrf', {headers: {'X-Forwarded-Proto': 'https'}});
  assert.equal(response.status, 200); assert.ok(response.headers.get('set-cookie').includes('Secure'));
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
});

test('public readiness reveals only minimal ready state and sanitizes backend failures', async t => {
  let healthy = true;
  const app = createApp({config: config(), repository: createMemoryRepository(), readinessCheck: async () => {if (!healthy) throw new Error('mongodb://user:password@private-host/secret'); return true;}});
  const url = await listen(t, app);
  const success = await fetch(url + '/api/v1/ready'); assert.equal(success.status, 200); assert.deepEqual((await success.json()).data, {status: 'ready'});
  healthy = false;
  const failure = await fetch(url + '/api/v1/ready'); assert.equal(failure.status, 503);
  const body = await failure.text(); assert.equal(body.includes('private-host'), false); assert.equal(body.includes('password'), false); assert.deepEqual(JSON.parse(body).data, {status: 'not_ready'});
  assert.equal(failure.headers.get('cache-control'), 'no-store');
});

test('readiness requires a connected writable replica set with sessions and coalesces probes', async () => {
  let calls = 0, time = 1000;
  const connection = {readyState: 1, db: {command: async (command, options) => {calls++; assert.equal(command.hello, 1); assert.ok(options.signal instanceof AbortSignal); return {isWritablePrimary: true, setName: 'private-set', logicalSessionTimeoutMinutes: 30};}}};
  const check = createReadinessCheck({connection, now: () => time});
  assert.deepEqual(await Promise.all([check(), check(), check()]), [true, true, true]); assert.equal(calls, 1);
  assert.equal(await check(), true); assert.equal(calls, 1);
  connection.readyState = 0; assert.equal(await check(), false);
  connection.readyState = 1; time += 2001; assert.equal(await check(), true); assert.equal(calls, 2);
  for (const hello of [{isWritablePrimary: true}, {isWritablePrimary: false, setName: 'rs', logicalSessionTimeoutMinutes: 30}, {isWritablePrimary: true, setName: 'rs', logicalSessionTimeoutMinutes: null}]) assert.equal(await createReadinessCheck({connection: {readyState: 1, db: {command: async () => hello}}})(), false);
});

test('readiness times out and aborts a stalled probe, then can recover after a failed command', async () => {
  let aborted = false;
  const stalled = createReadinessCheck({connection: {readyState: 1, db: {command: async (command, {signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {aborted = true; reject(new Error('Private diagnostic'));}))}}, timeoutMs: 50});
  const start = Date.now(); assert.equal(await stalled(), false); assert.equal(aborted, true); assert.ok(Date.now() - start < 1000);
  let fail = true;
  const recovery = createReadinessCheck({connection: {readyState: 1, db: {command: () => {if (fail) throw new Error('private failure'); return Promise.resolve({isWritablePrimary: true, setName: 'rs', logicalSessionTimeoutMinutes: 30});}}}, cacheMs: 0});
  assert.equal(await recovery(), false); fail = false; assert.equal(await recovery(), true);
});

test('production profile permits disabled mail only as an explicit local-only exception', () => {
  const local = production();
  assert.equal(assessProductionRuntime(local, {allowDisabledMail: true}).passed, true);
  assert.ok(assessProductionRuntime(local).issues.includes('REAL_EMAIL_CONFIGURATION_REQUIRED'));
  assert.equal(assessProductionRuntime({...local, appOrigin: 'https://studio.example.com'}, {allowDisabledMail: true}).passed, false);
  assert.equal(localProductionOrigin('https://studio.localhost:8443'), true); assert.equal(localProductionOrigin('https://localhost.evil.example'), false);
  const issues = assessProductionRuntime({...local, trustProxy: true, apiHost: '0.0.0.0', enforceHttps: false, requestLogging: false, mailEncryptionSecret: ''}, {allowDisabledMail: true}).issues;
  for (const issue of ['LOOPBACK_API_REQUIRED', 'LOOPBACK_PROXY_REQUIRED', 'HTTPS_ENFORCEMENT_REQUIRED', 'REQUEST_LOGGING_REQUIRED', 'INDEPENDENT_MAIL_ENCRYPTION_SECRET_REQUIRED']) assert.ok(issues.includes(issue));
  assert.equal(JSON.stringify(issues).includes(environment.JWT_SECRET), false);
});

test('request logs contain route templates and bounded metadata but omit private URL and payload values', async t => {
  const entries = [], app = express();
  app.use((req, res, next) => {req.requestId = 'server-generated-id'; next();});
  app.use(requestMetadataLogger({enabled: true, write: entry => entries.push(entry)}));
  app.use(express.json());
  app.post('/projects/:projectId/inspect', (req, res) => res.json({ok: true}));
  const url = await listen(t, app);
  const response = await fetch(url + '/projects/private-project-id/inspect?token=private-query', {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: 'token=private-cookie'}, body: JSON.stringify({email: 'private-inbox@example.test', prompt: 'private-prompt'})});
  assert.equal(response.status, 200); await response.text();
  assert.equal(entries.length, 1); assert.equal(entries[0].route, '/projects/:projectId/inspect');
  assert.deepEqual(Object.keys(entries[0]).sort(), ['durationMs', 'event', 'method', 'requestId', 'route', 'status']);
  assert.ok(Number.isFinite(entries[0].durationMs));
  const serialized = JSON.stringify(entries); for (const privateValue of ['private-project-id', 'private-query', 'private-cookie', 'private-inbox', 'private-prompt']) assert.equal(serialized.includes(privateValue), false);
});
