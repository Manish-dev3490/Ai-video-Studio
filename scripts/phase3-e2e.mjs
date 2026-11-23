import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {chromium, request, expect} from '@playwright/test';
import {startLocalMongo} from './local-mongo.mjs';
import {createApp} from '../apps/api/src/app.js';
import {loadConfig} from '../apps/api/src/config.js';
import {createMongoRepository} from '../apps/api/src/repository.js';
import {buildDashboardRouter, createDashboardModels} from '../apps/api/src/dashboard.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.join(root, 'artifacts/phase3/e2e-' + Date.now());
await fs.mkdir(outputDir, {recursive: true});
const report = {startedAt: new Date().toISOString(), checks: [], passed: false, outputDir, browserErrors: []};
const save = () => fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {const port = listener.address().port; listener.close(() => resolve(port));});
});
const databasePort = await freePort();
const apiPort = await freePort();
const origin = `http://127.0.0.1:${apiPort}`;
const config = {...loadConfig({NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase3_e2e`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url')}), authRateLimit: 100};
let mongo, connection, repository, models, server, browser;
const clients = [];
async function startApi() {
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  repository = createMongoRepository(connection);
  await repository.initialize();
  models = createDashboardModels(connection);
  await Promise.all(Object.values(models).map(model => model.init()));
  const app = createApp({config, repository, dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
}
async function stopApi() {
  if (server) {await new Promise(resolve => server.close(resolve)); server = undefined;}
  if (connection) {await connection.close(); connection = undefined;}
}
async function client(options = {}) {const value = await request.newContext({baseURL: origin, ...options}); clients.push(value); return value;}
async function csrf(context) {
  const response = await context.get('/api/v1/auth/csrf');
  assert.equal(response.status(), 200, 'CSRF bootstrap succeeds');
  return (await response.json()).data.csrfToken;
}
async function post(context, endpoint, data = {}) {
  const token = await csrf(context);
  return context.post('/api/v1' + endpoint, {headers: {Origin: origin, 'X-CSRF-Token': token}, data});
}
async function check(name, action) {
  await action();
  report.checks.push({name, passed: true});
  await save();
  process.stdout.write(JSON.stringify({event: 'E2E_CHECK_PASSED', name}) + '\n');
}
const credentials = suffix => ({displayName: 'Studio ' + suffix, email: `phase3-${Date.now()}-${suffix}@example.test`, password: 'Little stories find their own motion. 42'});
const userOne = credentials('one');
const userTwo = credentials('two');

try {
  await fs.access(path.join(root, 'apps/web/dist/index.html'));
  mongo = await startLocalMongo({directory: path.join(outputDir, 'mongodb'), port: databasePort});
  await startApi();
  const anonymous = await client();
  const owner = await client();
  const other = await client();
  let ownerId, otherId;
  await check('Protected auth and dashboard routes reject anonymous requests with no-store', async () => {
    for (const route of ['/auth/me', '/projects', '/usage', '/capabilities']) {
      const response = await anonymous.get('/api/v1' + route);
      assert.equal(response.status(), 401);
      assert.equal(response.headers()['cache-control'], 'no-store');
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'requestId']);
      assert.equal(body.requestId, response.headers()['x-request-id']);
    }
  });
  await check('Signup enforces CSRF and exact Origin, and rejects extra owner fields', async () => {
    const token = await csrf(anonymous);
    const missing = await anonymous.post('/api/v1/auth/signup', {data: userOne});
    assert.equal(missing.status(), 403);
    const foreign = await anonymous.post('/api/v1/auth/signup', {headers: {Origin: 'https://untrusted.example', 'X-CSRF-Token': token}, data: userOne});
    assert.equal(foreign.status(), 403);
    const extra = await post(anonymous, '/auth/signup', {...userOne, ownerId: 'attacker'});
    assert.equal(extra.status(), 422);
    const details = (await extra.json()).error.details;
    assert.equal(typeof details, 'object');
    assert.equal(Array.isArray(details), false);
  });
  await check('Real MongoDB signup stores Argon2id and only hashed refresh secrets', async () => {
    const response = await post(owner, '/auth/signup', userOne);
    assert.equal(response.status(), 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.data.user).sort(), ['displayName', 'email', 'id']);
    ownerId = body.data.user.id;
    const record = await repository.models.User.findById(ownerId).select('+passwordHash').lean();
    assert.ok(record.passwordHash.startsWith('$argon2id$'), 'Password uses Argon2id');
    assert.ok(record.passwordHash !== userOne.password, 'No plaintext password');
    const state = await owner.storageState();
    const refresh = state.cookies.find(cookie => cookie.name === 'avs_refresh');
    assert.ok(refresh && refresh.httpOnly && refresh.sameSite === 'Lax', 'Refresh cookie has browser protections');
    const session = await repository.models.Session.findOne({userId: ownerId}).select('+tokenHash +usedTokenHashes').lean();
    assert.ok(session.tokenHash.length === 64 && session.tokenHash !== refresh.value, 'Only a refresh hash is stored');
    assert.ok(!JSON.stringify(body).includes(record.passwordHash), 'Response excludes password hash');
  });
  await check('Duplicate normalized email and invalid credentials fail safely', async () => {
    assert.equal((await post(anonymous, '/auth/signup', {...userOne, email: userOne.email.toUpperCase()})).status(), 409);
    const wrong = await post(anonymous, '/auth/login', {...userOne, displayName: undefined, password: 'This is the wrong passphrase.'});
    assert.equal(wrong.status(), 401);
    const response = await post(other, '/auth/signup', userTwo);
    assert.equal(response.status(), 201);
    otherId = (await response.json()).data.user.id;
  });
  await check('Projects are owner-scoped, tombstoned rows hidden, and signed pagination is stable', async () => {
    const timestamp = new Date('2026-11-20T12:00:00Z');
    const settings = {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS', characterAssetId: null};
    const doc = (ownerId, title, deletedAt = null) => ({_id: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(ownerId), title, prompt: 'A synthetic ownership test prompt.', settings, phase: 'DRAFT', currentStoryboardId: null, latestGenerationId: null, latestOutputAssetId: null, deletedAt, createdAt: timestamp, updatedAt: timestamp});
    await models.Project.collection.insertMany([doc(ownerId, 'First owned project'), doc(ownerId, 'Second owned project'), doc(ownerId, 'Deleted project', timestamp), doc(otherId, 'Private to another account')]);
    const first = await owner.get('/api/v1/projects?limit=1');
    assert.equal(first.status(), 200);
    const firstBody = (await first.json()).data;
    assert.equal(firstBody.projects.length, 1);
    assert.ok(firstBody.nextCursor);
    assert.deepEqual(Object.keys(firstBody.projects[0]).sort(), ['createdAt', 'currentStoryboardId', 'id', 'latestGenerationId', 'latestOutputAssetId', 'phase', 'prompt', 'settings', 'title', 'updatedAt']);
    const second = await owner.get('/api/v1/projects?limit=1&cursor=' + encodeURIComponent(firstBody.nextCursor));
    const secondBody = (await second.json()).data;
    assert.equal(secondBody.projects.length, 1);
    assert.ok(secondBody.projects[0].id !== firstBody.projects[0].id, 'No duplicate on equal-timestamp cursor boundary');
    assert.equal(secondBody.nextCursor, null);
    assert.equal((await other.get('/api/v1/projects?cursor=' + encodeURIComponent(firstBody.nextCursor))).status(), 400);
    assert.equal((await owner.get('/api/v1/projects?cursor=' + encodeURIComponent(firstBody.nextCursor + 'x'))).status(), 400);
    for (const query of ['limit=0', 'limit=51', 'limit=2&limit=3', 'ownerId=' + otherId]) assert.equal((await owner.get('/api/v1/projects?' + query)).status(), 400);
    const owned = (await (await other.get('/api/v1/projects')).json()).data.projects;
    assert.equal(owned.length, 1);
    assert.equal(owned[0].title, 'Private to another account');
  });
  await check('Usage reads persisted per-user UTC buckets and capabilities report no connected worker', async () => {
    const baseline = (await (await owner.get('/api/v1/usage')).json()).data;
    assert.equal(baseline.used, 0);
    assert.equal(baseline.dailyLimit, 3);
    assert.equal(await models.UsageBucket.countDocuments(), 0, 'Reading usage does not reserve quota');
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    await models.UsageBucket.create({userId: ownerId, periodStart, limit: 4, consumed: 2, reserved: 1});
    const usage = (await (await owner.get('/api/v1/usage')).json()).data;
    assert.equal(usage.dailyLimit, 4); assert.equal(usage.used, 2); assert.equal(usage.reserved, 1);
    assert.equal((await (await other.get('/api/v1/usage')).json()).data.used, 0);
    const caps = (await (await owner.get('/api/v1/capabilities')).json()).data;
    assert.deepEqual(caps.worker, {available: false, status: 'OFFLINE'});
    assert.deepEqual(caps.languages, ['en']); assert.deepEqual(caps.aspectRatios, ['16:9']);
    assert.equal(caps.templates.length, 5);
  });
  await check('Rotated refresh replay invalidates the entire logical session, including issued access JWTs', async () => {
    const oldState = await owner.storageState();
    const oldRefresh = oldState.cookies.find(cookie => cookie.name === 'avs_refresh').value;
    assert.equal((await post(owner, '/auth/refresh')).status(), 200);
    const newRefresh = (await owner.storageState()).cookies.find(cookie => cookie.name === 'avs_refresh').value;
    assert.ok(oldRefresh !== newRefresh, 'Refresh secret changes');
    const stale = await client({storageState: oldState});
    assert.equal((await post(stale, '/auth/refresh')).status(), 401);
    assert.equal((await owner.get('/api/v1/auth/me')).status(), 401);
  });
  await check('Concurrent refresh requests cannot resurrect a revoked MongoDB session', async () => {
    const racing = await client();
    assert.equal((await post(racing, '/auth/login', {email: userOne.email, password: userOne.password})).status(), 200);
    const token = await csrf(racing);
    const state = await racing.storageState();
    const first = await client({storageState: state});
    const second = await client({storageState: state});
    const responses = await Promise.all([first.post('/api/v1/auth/refresh', {headers: {Origin: origin, 'X-CSRF-Token': token}, data: {}}), second.post('/api/v1/auth/refresh', {headers: {Origin: origin, 'X-CSRF-Token': token}, data: {}})]);
    assert.ok(responses.some(response => response.status() === 401), 'At least one stale CAS is rejected');
    assert.equal((await first.get('/api/v1/auth/me')).status(), 401);
    assert.equal((await second.get('/api/v1/auth/me')).status(), 401);
  });

  browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const browserContext = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  const page = await browserContext.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 300)));
  const browserUser = credentials('browser');
  await check('Browser redirects anonymous protected navigation and creates a real account through the UI', async () => {
    await page.goto(origin + '/app');
    await expect(page).toHaveURL(/\/login$/u);
    await page.getByRole('link', {name: 'Create account', exact: true}).click();
    await page.screenshot({path: path.join(outputDir, 'signup-desktop.png'), fullPage: true});
    await page.getByLabel('Your name', {exact: true}).fill(browserUser.displayName);
    await page.getByLabel('Email address', {exact: true}).fill(browserUser.email);
    await page.getByLabel('Password', {exact: true}).fill('short');
    await page.getByRole('button', {name: 'Create account', exact: true}).click();
    await expect(page.locator('#password-error')).toBeVisible();
    await page.getByLabel('Password', {exact: true}).fill(browserUser.password);
    await page.getByRole('button', {name: 'Create account', exact: true}).click();
    await expect(page).toHaveURL(/\/app$/u);
    await expect(page.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    await page.screenshot({path: path.join(outputDir, 'dashboard-desktop.png'), fullPage: true});
    assert.ok(await repository.models.User.exists({emailNormalized: browserUser.email}), 'UI signup is persisted');
  });
  await check('Session survives reload and simultaneous tab recovery without token storage', async () => {
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    const cookies = await browserContext.cookies(origin + '/api/v1/auth/me');
    assert.ok(cookies.filter(cookie => ['avs_access', 'avs_refresh', 'avs_csrf'].includes(cookie.name)).every(cookie => cookie.httpOnly), 'Auth/bootstrap cookies are HttpOnly');
    const storage = await page.evaluate(() => ({local: Object.keys(localStorage), session: Object.keys(sessionStorage)}));
    assert.deepEqual(storage, {local: [], session: []});
    await browserContext.clearCookies({name: 'avs_access'});
    const tab = await browserContext.newPage();
    tab.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 300)));
    await Promise.all([page.reload(), tab.goto(origin + '/app')]);
    await expect(page.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    await expect(tab.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    await tab.close();
  });
  await check('Populated project UI uses canonical phases, filters, search and current-owner data', async () => {
    const user = await repository.models.User.findOne({emailNormalized: browserUser.email});
    const settings = {mode: 'FACELESS', durationSec: 60, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS', characterAssetId: null};
    await models.Project.create([
      {ownerId: user._id, title: 'Ocean currents: ready for review', prompt: 'Synthetic review fixture.', settings, phase: 'REVIEW'},
      {ownerId: user._id, title: 'The solar system: rendering', prompt: 'Synthetic rendering fixture.', settings, phase: 'RENDERING'},
      {ownerId: user._id, title: 'How rain forms: saved output', prompt: 'Synthetic output fixture.', settings, phase: 'HAS_OUTPUT'},
    ]);
    await page.goto(origin + '/app/projects');
    await expect(page.getByRole('heading', {name: 'Ocean currents: ready for review'})).toBeVisible();
    await page.getByLabel('Filter by project status').selectOption('REVIEW');
    await expect(page.getByRole('heading', {name: 'Ocean currents: ready for review'})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'The solar system: rendering'})).toHaveCount(0);
    await page.getByLabel('Filter by project status').selectOption('HAS_OUTPUT');
    await expect(page.getByRole('heading', {name: 'How rain forms: saved output'})).toBeVisible();
    await page.getByLabel('Filter by project status').selectOption('ALL');
    await page.getByLabel('Search loaded projects by title').fill('solar');
    await expect(page.getByRole('heading', {name: 'The solar system: rendering'})).toBeVisible();
    await expect(page.getByText('First owned project', {exact: true})).toHaveCount(0);
    await page.getByLabel('Search loaded projects by title').fill('');
    await page.screenshot({path: path.join(outputDir, 'projects-synthetic-fixtures.png'), fullPage: true});
  });
  await check('Dashboard API outage shows a recoverable error without a false logout', async () => {
    const route = /\/api\/v1\/projects(?:\?|$)/u;
    await page.route(route, request => request.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: {code: 'DATABASE_UNAVAILABLE', message: 'Temporarily unavailable.', retryable: true}, requestId: 'e2e_outage'})}));
    await page.goto(origin + '/app');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/app$/u);
    await page.unroute(route);
    await page.getByRole('button', {name: 'Try again', exact: true}).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await check('Protected projects/account navigation, mobile layout and logout work', async () => {
    await page.getByRole('link', {name: 'My projects', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/projects$/u);
    await page.getByRole('link', {name: 'Account', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/settings$/u);
    await expect(page.getByText(browserUser.email, {exact: true})).toBeVisible();
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(origin + '/app');
    await expect(page.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No mobile horizontal overflow');
    await page.screenshot({path: path.join(outputDir, 'dashboard-mobile.png'), fullPage: true});
    await page.getByRole('button', {name: 'Open navigation', exact: true}).click();
    await expect(page.getByRole('link', {name: 'My projects', exact: true})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', {name: 'Open navigation', exact: true})).toBeFocused();
    await page.setViewportSize({width: 1440, height: 1000});
    const peer = await browserContext.newPage();
    await peer.goto(origin + '/app');
    await expect(peer.getByRole('heading', {name: 'Bring your ideas to motion.'})).toBeVisible();
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await expect(page).toHaveURL(/\/login$/u);
    await expect(peer).toHaveURL(/\/login$/u);
    await peer.close();
    await page.screenshot({path: path.join(outputDir, 'login-desktop.png'), fullPage: true});
    await page.goto(origin + '/app/settings');
    await expect(page).toHaveURL(/\/login$/u);
    await page.getByLabel('Email address', {exact: true}).fill(browserUser.email);
    await page.getByLabel('Password', {exact: true}).fill('This password is incorrect.');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Password', {exact: true}).fill(browserUser.password);
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/settings$/u);
  });
  await browser.close(); browser = undefined;
  await check('Accounts and sessions survive API and dedicated MongoDB process restart', async () => {
    await stopApi(); await mongo.stop();
    mongo = await startLocalMongo({directory: path.join(outputDir, 'mongodb'), port: databasePort});
    await startApi();
    const response = await other.get('/api/v1/auth/me');
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).data.user.email, userTwo.email);
    const record = await repository.models.User.findById(otherId).lean();
    assert.equal(record.status, 'ACTIVE');
    await repository.models.User.updateOne({_id: otherId}, {$set: {status: 'SUSPENDED'}});
    assert.equal((await other.get('/api/v1/auth/me')).status(), 401);
    assert.equal((await post(other, '/auth/refresh')).status(), 401);
  });
  assert.equal(report.browserErrors.length, 0, 'No uncaught browser errors');
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).slice(0, 1200)};
  process.stderr.write(JSON.stringify({event: 'E2E_FAILED', ...report.failure, reportPath: path.join(outputDir, 'report.json')}) + '\n');
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await Promise.all(clients.map(context => context.dispose()));
  await stopApi().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString();
  await save();
  process.stdout.write(JSON.stringify({event: 'PHASE3_E2E_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(outputDir, 'report.json')}) + '\n');
}
