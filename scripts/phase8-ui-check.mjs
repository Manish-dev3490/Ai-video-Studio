import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
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
import {publicStoryboard} from '../apps/api/src/projects/validation.js';
import {hashApprovedStoryboard} from '../packages/video-engine/src/contracts.js';
import {narrationWords} from '../apps/api/src/projects/duration-feedback.js';
import {ApiError} from '../apps/api/src/http.js';

// Browser/auth/MongoDB are real. Timing evidence and AI output are explicit
// synthetic fixtures. This checks recovery/control flow, not media quality.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `ui-check-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase8', runId);
const privateRoot = path.join(root, 'var/phase8-tests', runId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), mode: 'FIXTURE_DURATION_REAL_BROWSER_MONGO', realGemini: false, realTts: false, realRender: false, realWorker: false, syntheticTimingEvidence: true, fixturePlannerCalls: 0, externalRequests: 0, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const port = () => new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const databasePort = await port(), apiPort = await port(), origin = `http://127.0.0.1:${apiPort}`;
const environment = {NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase8_ui?replicaSet=phase8Ui`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), GEMINI_API_KEY: '', GOOGLE_API_KEY: '', MAIL_TRANSPORT: 'disabled', PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')};
const config = {...loadConfig(environment), authRateLimit: 100, planningRateLimit: 100};
const fixture = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8'));
const password = 'Measured timing fixture review stays private. 42';
let mongo, connection, models, server, browser, context, page, ownerId, slowBegin, slowFinish;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {report.externalRequests++; return Promise.reject(new Error('EXTERNAL_REQUEST_DISABLED'));} return originalFetch(input, ...args);};
async function check(name, work) {await work(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE8_UI_PASSED', name}) + '\n');}
async function data(response, status = 200) {const body = await response.json(); assert.equal(response.status(), status, body.error?.code || 'Unexpected API response'); return body.data;}
async function mutate(method, route, body = {}) {const proof = await data(await context.request.get(origin + '/api/v1/auth/csrf')); return context.request.fetch(origin + '/api/v1' + route, {method, headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken}, data: body});}
async function seededFailure(label = 'Timing fixture') {
  const item = await models.Project.create({ownerId, title: label, prompt: 'Explain the JavaScript event loop. ' + label, settings: fixture.settingsSnapshot, phase: 'REVIEW'});
  const storyboardId = new mongoose.Types.ObjectId();
  const canonical = {...structuredClone(fixture), id: String(storyboardId), projectId: String(item._id), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), approvedAt: new Date().toISOString()};
  const contentHash = hashApprovedStoryboard(canonical);
  await models.Storyboard.create({_id: storyboardId, ownerId, projectId: item._id, revision: canonical.revision, status: 'APPROVED', schemaVersion: 1, targetDurationSec: 30, settingsSnapshot: canonical.settingsSnapshot, scenes: canonical.scenes, approvedAt: canonical.approvedAt, contentHash});
  const audio = canonical.scenes.map(() => 10000);
  const measuredDurationSec = audio.reduce((sum, ms) => sum + 12 + Math.ceil(ms * 30 / 1000), 0) / 30;
  const job = await models.GenerationJob.create({ownerId, projectId: item._id, storyboardId, approvedRevision: canonical.revision, status: 'FAILED', stage: 'ALIGN_TIMELINE', snapshot: canonical, storyboardHash: contentHash, error: {code: 'DURATION_REVISION_REQUIRED', message: 'Synthetic fixture duration mismatch.', retryable: false}, manifest: {durationFeedback: {measurementVersion: 1, sourceStoryboardHash: contentHash, targetDurationSec: 30, measuredDurationSec, narrationWords: narrationWords(canonical), sceneCount: canonical.scenes.length, sceneAudioDurationMs: audio, voice: 'af_heart', speed: 1, language: 'en'}}});
  await models.Project.updateOne({_id: item._id}, {$set: {currentStoryboardId: storyboardId, latestGenerationId: job._id}});
  return {projectId: String(item._id), storyboardId: String(storyboardId), generationId: String(job._id), revision: canonical.revision, contentHash};
}
const showFailure = item => page.goto(origin + `/app/projects/${item.projectId}/generating?generation=${item.generationId}`);
try {
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: databasePort, replicaSet: 'phase8Ui'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const planner = async ({durationRevision, settings, prompt, signal}) => {
    report.fixturePlannerCalls++;
    assert.ok(durationRevision?.feedback && Array.isArray(durationRevision.scenes));
    if (prompt.includes('Slow fixture')) {slowBegin?.(); await new Promise(resolve => {slowFinish = resolve;}); if (signal?.aborted) throw new ApiError(503, 'REQUEST_ABORTED', 'Fixture request cancelled.');}
    // Fixture-only prose truncation exercises contract/control flow. It makes
    // no claim to AI factual quality, real pronunciation or measured duration.
    const words = durationRevision.scenes.flatMap(scene => scene.narration.trim().split(/\s+/u)).slice(0, durationRevision.feedback.suggestedNarrationWords);
    const size = durationRevision.scenes.length;
    const scenes = durationRevision.scenes.map((scene, index) => ({...structuredClone(scene), narration: words.slice(Math.floor(index * words.length / size), Math.floor((index + 1) * words.length / size)).join(' '), estimatedDurationSec: settings.durationSec / size}));
    return {schemaVersion: 1, targetDurationSec: settings.durationSec, scenes};
  };
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, planner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize();
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  await context.route('**/*', route => {const target = new URL(route.request().url()); if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return route.continue(); report.externalRequests++; return route.abort();});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 500)));
  await page.goto(origin + '/signup'); await page.getByLabel('Your name', {exact: true}).fill('Duration Fixture Review'); await page.getByLabel('Email address', {exact: true}).fill(`duration-${Date.now()}@example.test`); await page.getByLabel('Password', {exact: true}).fill(password); await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
  ownerId = (await data(await context.request.get(origin + '/api/v1/auth/me'))).user.id;

  const first = await seededFailure();
  await check('Measured timing is shown without a provider request; explicit correction saves an unapproved new draft', async () => {
    await showFailure(first);
    const section = page.getByRole('region', {name: 'Narration timing feedback'});
    await expect(section).toContainText('41.60 seconds'); await expect(section).toContainText('30 seconds');
    assert.equal(report.fixturePlannerCalls, 0);
    await page.screenshot({path: path.join(output, 'measured-duration-feedback.png'), fullPage: true});
    await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${first.projectId}/review\\?durationSource=${first.generationId}$`, 'u'));
    await expect(page.getByRole('status').filter({hasText: 'A corrected draft is saved for review.'})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Review draft · revision 1', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Approve script', exact: true})).toBeEnabled();
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toHaveCount(0);
    const current = await models.Project.findById(first.projectId).lean();
    const revised = await models.Storyboard.findById(current.currentStoryboardId).lean(); assert.equal(revised.status, 'DRAFT'); assert.equal(String(revised.parentStoryboardId), first.storyboardId);
    assert.equal((await models.Storyboard.findById(first.storyboardId).lean()).contentHash, first.contentHash); assert.equal(report.fixturePlannerCalls, 1);
    assert.equal(await models.Reservation.countDocuments(), 0);
    await page.screenshot({path: path.join(output, 'corrected-draft-needs-approval.png'), fullPage: true});
    const approval = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/approve'));
    await page.getByRole('button', {name: 'Approve script', exact: true}).click(); await data(await approval);
    assert.equal((await models.Storyboard.findById(revised._id).lean()).status, 'APPROVED');
  });

  await check('A lost correction response after commit is recovered by GET with one fixture provider call', async () => {
    const item = await seededFailure('Lost response fixture'); let dropped = false;
    await page.route('**/storyboards/revise-duration', async route => {const response = await route.fetch(); assert.equal(response.status(), 201); dropped = true; await route.abort('failed');});
    await showFailure(item); await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${item.projectId}/review\\?durationSource=${item.generationId}$`, 'u'));
    await expect(page.getByRole('heading', {name: 'Review draft · revision 1', exact: true})).toBeVisible();
    await page.unroute('**/storyboards/revise-duration');
    assert.equal(dropped, true); assert.equal(report.fixturePlannerCalls, 2);
    assert.equal(await models.Storyboard.countDocuments({projectId: item.projectId}), 2);
    await showFailure(item); await expect(page.getByRole('link', {name: 'Open corrected draft', exact: true})).toBeVisible();
    assert.equal(await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).count(), 0);
  });

  await check('Changed source settings and safety holds prevent stale correction without provider work', async () => {
    const changed = await seededFailure('Changed settings fixture');
    await data(await mutate('PATCH', `/projects/${changed.projectId}`, {settings: {durationSec: 60}}));
    const response = await mutate('POST', `/projects/${changed.projectId}/storyboards/revise-duration`, {generationId: changed.generationId, storyboardId: changed.storyboardId, expectedRevision: changed.revision});
    assert.equal(response.status(), 409);
    await showFailure(changed); await expect(page.getByText('This attempt belongs to an earlier script.', {exact: false})).toBeVisible();
    assert.equal(await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).count(), 0);
    const held = await seededFailure('Held fixture'); await models.Project.updateOne({_id: held.projectId}, {$set: {safetyHoldAt: new Date(), safetyHoldReason: 'SAFETY'}});
    await showFailure(held); await expect(page.getByRole('region', {name: 'Narration timing feedback'}).getByRole('alert')).toContainText('safety review');
    assert.equal(await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).count(), 0); assert.equal(report.fixturePlannerCalls, 2);
  });

  await check('A same-owner cross-tab session reset fences a late correction callback', async () => {
    const item = await seededFailure('Slow fixture'); const began = new Promise(resolve => {slowBegin = resolve;});
    await showFailure(item); await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).click(); await began;
    await page.evaluate(() => {const channel = new BroadcastChannel('avs-session-changes'); channel.postMessage({type: 'SESSION_CHANGED'}); channel.close();});
    await expect(page.getByRole('button', {name: 'Revising narration…', exact: true})).toHaveCount(0);
    slowFinish(); slowFinish = null;
    await expect(page).toHaveURL(new RegExp(`/projects/${item.projectId}/generating\\?generation=${item.generationId}$`, 'u'));
    await expect.poll(async () => (await models.Project.findById(item.projectId).lean()).planningToken).toBe(null);
    assert.equal(await models.Storyboard.countDocuments({projectId: item.projectId}), 1); assert.equal(report.fixturePlannerCalls, 3);
  });

  await check('Mobile timing feedback remains readable and owner-scoped feedback rejects another account', async () => {
    await page.setViewportSize({width: 390, height: 844}); await showFailure(first);
    await expect(page.getByRole('region', {name: 'Narration timing feedback'})).toContainText('41.60 seconds');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: path.join(output, 'mobile-duration-feedback.png'), fullPage: true});
    const foreign = await models.GenerationJob.findById(first.generationId).lean(); await models.GenerationJob.updateOne({_id: foreign._id}, {$set: {ownerId: new mongoose.Types.ObjectId()}});
    assert.equal((await context.request.get(origin + `/api/v1/generations/${first.generationId}/narration-feedback`)).status(), 404);
    await models.GenerationJob.updateOne({_id: foreign._id}, {$set: {ownerId: foreign.ownerId}});
  });

  assert.equal(report.browserErrors.length, 0); assert.equal(report.externalRequests, 0); assert.equal(await models.Reservation.countDocuments(), 0); assert.equal(await models.MediaAsset.countDocuments(), 0);
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(password, '[REDACTED]').slice(0, 1800)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE8_UI_FAILED', ...report.failure}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  slowFinish?.();
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  globalThis.fetch = originalFetch;
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE8_UI_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
