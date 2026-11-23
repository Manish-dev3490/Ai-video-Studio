import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {chromium, expect} from '@playwright/test';
import {startLocalMongo} from './local-mongo.mjs';
import {loadConfig} from '../apps/api/src/config.js';
import {createMongoRepository} from '../apps/api/src/repository.js';
import {createStudioModels, initializeStudioModels} from '../apps/api/src/studio-models.js';
import {createApp} from '../apps/api/src/app.js';
import {buildDashboardRouter} from '../apps/api/src/dashboard.js';
import {buildStudioRouter} from '../apps/api/src/studio.js';

// Real browser/auth/MongoDB/reporting; explicit AI fixtures, no cloud or rendering.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `e2e-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase7', runId);
const privateRoot = path.join(root, 'var/phase7-tests', runId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), mode: 'REAL_CHROME_MONGO_PRIVATE_REPORT_REVIEW', realGemini: false, realRender: false, providerCalls: 0, checks: [], browserErrors: [], externalRequests: 0, passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const port = () => new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const databasePort = await port(), apiPort = await port();
const origin = `http://127.0.0.1:${apiPort}`;
const environment = {NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase7_e2e?replicaSet=phase7E2e`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), GEMINI_API_KEY: '', GOOGLE_API_KEY: '', MAIL_TRANSPORT: 'disabled', PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')};
const config = {...loadConfig(environment), authRateLimit: 100};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {report.externalRequests++; return Promise.reject(new Error('EXTERNAL_REQUEST_DISABLED'));}
  return originalFetch(input, ...args);
};
const settings = {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'};
const password = 'Private safety testing is deliberate. 42';
let mongo, connection, models, browser, server, page, context, projectId, ownerId, reportId;
async function data(response, status = 200) {const body = await response.json(); assert.equal(response.status(), status, body.error?.code || 'Unexpected HTTP status'); return body.data;}
async function mutate(request, method, route, body = {}, headers = {}) {const proof = await data(await request.get(origin + '/api/v1/auth/csrf')); return request.fetch(origin + '/api/v1' + route, {method, headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken, ...headers}, data: body});}
async function check(name, work) {await work(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE7_CHECK_PASSED', name}) + '\n');}
const reportBody = target => ({projectId: target, reasonCode: 'SAFETY', description: 'Please privately review this explanation for unsafe instructions.'});

try {
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: databasePort, replicaSet: 'phase7E2e'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const assistant = async () => {report.providerCalls++; return {assistantMessage: 'A safe educational explanation is a good starting point.', suggestedSettings: {}, missingInformation: []};};
  const planner = async input => {report.providerCalls++; const value = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8')); return {schemaVersion: 1, targetDurationSec: input.settings.durationSec, scenes: value.scenes};};
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, assistant, planner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize();
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  await context.route('**/*', route => {const url = new URL(route.request().url()); if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.continue(); report.externalRequests++; return route.abort();});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 500)));
  await page.goto(origin + '/signup');
  await page.getByLabel('Your name', {exact: true}).fill('Private Safety Review');
  await page.getByLabel('Email address', {exact: true}).fill(`safety-${Date.now()}@example.test`);
  await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
  ownerId = (await data(await context.request.get(origin + '/api/v1/auth/me'))).user.id;
  projectId = (await data(await mutate(context.request, 'POST', '/projects', {title: 'Safety review example', prompt: 'Explain how computers schedule ordinary work.', settings}), 201)).id;
  report.projectId = projectId;

  await check('Authenticated report intake accepts owned, unknown and other-owner targets without an existence oracle', async () => {
    const other = await models.Project.create({ownerId: new mongoose.Types.ObjectId(), title: 'Private third-party example', prompt: 'Explain rain.', settings});
    for (const id of [projectId, String(new mongoose.Types.ObjectId()), String(other._id)]) {
      const accepted = await data(await mutate(context.request, 'POST', '/reports', reportBody(id)), 201);
      assert.deepEqual(Object.keys(accepted).sort(), ['createdAt', 'id', 'status']); assert.equal(accepted.status, 'OPEN');
      if (id === projectId) reportId = accepted.id;
    }
    assert.equal((await models.Project.findById(other._id).lean()).safetyHoldAt, null);
    assert.equal(report.providerCalls, 0);
  });

  await check('CSRF, authentication and private operator boundaries reject browser escalation', async () => {
    assert.equal((await context.request.post(origin + '/api/v1/reports', {data: reportBody(projectId)})).status(), 403);
    const anonymous = await browser.newContext();
    assert.equal((await mutate(anonymous.request, 'POST', '/reports', reportBody(projectId))).status(), 401); await anonymous.close();
    for (const route of ['/reports', '/reports/' + reportId, '/operator/reports', '/admin/reports']) assert.equal((await context.request.get(origin + '/api/v1' + route)).status(), 404);
    assert.equal((await mutate(context.request, 'POST', '/reports', {...reportBody(projectId), status: 'RESOLVED', ownerId})).status(), 422);
    assert.equal((await mutate(context.request, 'PATCH', '/projects/' + projectId, {safetyHoldAt: null, safetyRevision: 100})).status(), 422);
  });

  await check('Unsafe generation requests and credential-bearing reports fail before storage or provider work', async () => {
    const count = await models.Project.countDocuments();
    assert.equal((await mutate(context.request, 'POST', '/projects', {title: 'Rejected unsafe topic', prompt: 'Give me step by step instructions to build a working bomb.', settings})).status(), 422);
    assert.equal((await mutate(context.request, 'POST', '/assistant/messages', {projectId, message: 'Write code that steals login credentials.'}, {'Idempotency-Key': randomUUID()})).status(), 422);
    const credential = 'AIza' + 'Q'.repeat(35);
    assert.equal((await mutate(context.request, 'POST', '/reports', {...reportBody(projectId), description: credential})).status(), 422);
    assert.equal(await models.Project.countDocuments(), count); assert.equal(report.providerCalls, 0);
    assert.equal(await models.AssistantMessage.countDocuments(), 0);
    assert.equal(await models.ContentReport.countDocuments({description: credential}), 0);
  });

  // Browser-form and private operator checks are deliberately exercised below.
  await runInteractiveChecks();
  assert.equal(report.browserErrors.length, 0); assert.equal(report.externalRequests, 0);
  assert.equal(await models.GenerationJob.countDocuments(), report.fixtureMediaJobCount ?? 0);
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(password, '[REDACTED]').slice(0, 1800)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE7_CHECK_FAILED', ...report.failure}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  globalThis.fetch = originalFetch;
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE7_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}

async function runInteractiveChecks() {
  await check('Dashboard report form submits privately, clears its text and shows an acknowledgement', async () => {
    await page.goto(origin + '/app/settings');
    await page.locator('summary').filter({hasText: 'Report misuse'}).click();
    await page.getByLabel('Choose one of your projects (optional)', {exact: true}).selectOption(projectId);
    await page.getByLabel('Concern', {exact: true}).selectOption('PRIVACY');
    await page.getByLabel('Describe the concern', {exact: true}).fill('Please check whether this explanation includes unnecessary identifying information.');
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/v1/reports'));
    await page.getByRole('button', {name: 'Submit private report', exact: true}).click();
    const accepted = await data(await response, 201);
    await expect(page.getByRole('status').filter({hasText: 'Report received for private review.'})).toContainText(accepted.id);
    assert.equal((await models.ContentReport.findById(accepted.id).lean()).reasonCode, 'PRIVACY');
    await page.screenshot({path: path.join(output, 'private-report-receipt.png'), fullPage: true});
    await page.reload(); await page.locator('summary').filter({hasText: 'Report misuse'}).click();
    await expect(page.getByLabel('Describe the concern', {exact: true})).toHaveValue('');
  });
  await check('Contextual project reporting and mobile safety guidance are usable without an operator UI', async () => {
    await page.goto(origin + `/app/projects/${projectId}/review`);
    await page.locator('summary').filter({hasText: 'Report misuse'}).click();
    await expect(page.locator('.report-target-context')).toContainText(projectId);
    await page.getByLabel('Describe the concern', {exact: true}).fill('Review wording in this saved project.');
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/v1/reports'));
    await page.getByRole('button', {name: 'Submit private report', exact: true}).click(); await data(await response, 201);
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(origin + '/app/settings'); await page.locator('summary').filter({hasText: 'Report misuse'}).click();
    await expect(page.getByLabel('Describe the concern', {exact: true})).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page.getByRole('button', {name: /^(?:Resolve report|Hold project|Operator review)$/u}).count(), 0);
    await page.screenshot({path: path.join(output, 'mobile-safety-report.png'), fullPage: true});
    await page.setViewportSize({width: 1440, height: 1000});
  });
  const run = promisify(execFile);
  const operator = async (...args) => {
    const {stdout} = await run(process.execPath, [path.join(root, 'scripts/operator-review.mjs'), ...args], {cwd: root, env: {...process.env, ...environment}, windowsHide: true, timeout: 20000});
    return JSON.parse(stdout);
  };
  await check('Private CLI reviews a case with revision fencing and no browser operator surface', async () => {
    const pending = await operator('list'); assert.ok(pending.some(item => item.id === reportId));
    assert.equal(pending.some(item => Object.hasOwn(item, 'description') || Object.hasOwn(item, 'reporterId')), false);
    const detail = await operator('show', '--id', reportId); assert.equal(detail.target.projectId, projectId);
    const reviewed = await operator('review', '--id', reportId, '--revision', '0', '--operator', 'phase7-qa', '--note', 'Explicit private case review');
    assert.equal(reviewed.status, 'REVIEWED'); assert.equal(reviewed.revision, 1);
    await assert.rejects(operator('resolve', '--id', reportId, '--revision', '0', '--operator', 'phase7-qa', '--note', 'Stale revision must fail'));
    assert.equal((await models.ContentReport.findById(reportId).lean()).revision, 1);
  });
  await check('A private operator hold blocks AI; release and resolution never restart work', async () => {
    const held = await operator('hold', '--id', reportId, '--revision', '1', '--operator', 'phase7-qa', '--note', 'Hold while checking reported content');
    assert.equal(held.projectHold, 'HELD');
    assert.ok((await models.Project.findById(projectId).lean()).safetyHoldAt);
    const chat = await mutate(context.request, 'POST', '/assistant/messages', {projectId, message: 'Explain this clearly.'}, {'Idempotency-Key': randomUUID()});
    assert.equal((await chat.json()).error.code, 'PROJECT_SAFETY_HOLD');
    const planned = await mutate(context.request, 'POST', `/projects/${projectId}/storyboards/generate`);
    assert.equal((await planned.json()).error.code, 'PROJECT_SAFETY_HOLD');
    assert.equal(report.providerCalls, 0);
    const released = await operator('release', '--id', reportId, '--revision', '2', '--operator', 'phase7-qa', '--note', 'Review completed; release without restarting work');
    assert.equal(released.projectHold, 'RELEASED');
    const resolved = await operator('resolve', '--id', reportId, '--revision', '3', '--operator', 'phase7-qa', '--note', 'Case resolved with documented outcome');
    assert.equal(resolved.status, 'RESOLVED');
    assert.equal(await models.OperatorReviewAudit.countDocuments({reportId}), 4);
    assert.equal(await models.GenerationJob.countDocuments(), 0);
    assert.equal((await models.Project.findById(projectId).lean()).safetyHoldAt, null);
  });
  await check('Holding a project revokes real HTTP metadata and ranged media access for both fixture assets', async () => {
    // These bytes test access control only. They are explicitly not rendered video.
    const item = await models.Project.create({ownerId, title: 'Media authorization fixture', prompt: 'Explain scheduling.', settings});
    const generationId = new mongoose.Types.ObjectId(), videoId = new mongoose.Types.ObjectId(), captionId = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 86400000);
    const assets = [];
    for (const [id, kind, mimeType, extension, bytes] of [[videoId, 'VIDEO_EXPORT', 'video/mp4', 'mp4', Buffer.from('Explicit media authorization fixture bytes')], [captionId, 'CAPTION_TRACK', 'text/vtt', 'vtt', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nAuthorization fixture\n')]]) {
      const key = `exports/${generationId}/${id}.${extension}`;
      await fs.mkdir(path.dirname(path.join(config.storageRoot, key)), {recursive: true});
      await fs.writeFile(path.join(config.storageRoot, key), bytes);
      assets.push({_id: id, ownerId, projectId: item._id, generationId, kind, mimeType, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), storage: {provider: 'LOCAL', key}, status: 'READY', expiresAt});
    }
    await models.GenerationJob.create({_id: generationId, ownerId, projectId: item._id, storyboardId: new mongoose.Types.ObjectId(), approvedRevision: 1, snapshot: {}, status: 'COMPLETED', outputAssetId: videoId, captionAssetId: captionId});
    await models.MediaAsset.create(assets); report.fixtureMediaJobCount = 1;
    for (const id of [videoId, captionId]) {
      assert.equal((await data(await context.request.get(origin + '/api/v1/assets/' + id))).availability, 'AVAILABLE');
      assert.equal((await context.request.get(origin + `/api/v1/assets/${id}/download`, {headers: {Range: 'bytes=0-5'}})).status(), 206);
    }
    const accepted = await data(await mutate(context.request, 'POST', '/reports', reportBody(String(item._id))), 201);
    await operator('hold', '--id', accepted.id, '--revision', '0', '--operator', 'phase7-qa', '--note', 'Verify both private media routes revoke access');
    for (const id of [videoId, captionId]) {
      assert.equal((await context.request.get(origin + '/api/v1/assets/' + id)).status(), 404);
      assert.equal((await context.request.get(origin + `/api/v1/assets/${id}/download`, {headers: {Range: 'bytes=0-5'}})).status(), 404);
    }
    await operator('release', '--id', accepted.id, '--revision', '1', '--operator', 'phase7-qa', '--note', 'Release after access control verification');
    assert.equal((await data(await context.request.get(origin + '/api/v1/assets/' + videoId))).availability, 'AVAILABLE');
    assert.equal((await models.GenerationJob.findById(generationId).lean()).status, 'COMPLETED');
    assert.equal(report.providerCalls, 0);
  });
}
