import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
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

// Explicit fixture integration test: no real Gemini, TTS, Remotion or worker.
// Run only after building apps/web; all database/state belongs to this new run.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `ui-check-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase4', runId);
const privateRoot = path.join(root, 'var/phase4-ui-check', runId);
await fs.mkdir(output, {recursive: true});
const report = {
  startedAt: new Date().toISOString(), executionMode: 'FIXTURE_PLANNER_REAL_MONGODB_BROWSER_UI',
  realGemini: false, realTts: false, realRender: false, realWorker: false,
  fixturePlannerCalls: 0, generationAdmissionCalls: 0, blockedExternalFetches: 0,
  syntheticWorkerHeartbeat: true, syntheticQueuedJobFixture: false,
  checks: [], browserErrors: [], passed: false,
};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer(); listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});
});
const databasePort = await freePort();
const apiPort = await freePort();
const origin = `http://127.0.0.1:${apiPort}`;
const config = {
  ...loadConfig({
    NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort),
    MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase4_ui_check?replicaSet=phase4UiCheck`,
    JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'),
    // Deliberately do not inherit any provider credentials from the shell.
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
    PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs'),
  }),
  authRateLimit: 100,
};
const fixture = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8'));
const planner = async ({settings}) => {
  assert.equal(settings.durationSec, 30, 'This explicit planner fixture supports only the initial 30-second draft.');
  report.fixturePlannerCalls++;
  return {schemaVersion: fixture.schemaVersion, targetDurationSec: fixture.targetDurationSec, scenes: structuredClone(fixture.scenes)};
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    report.blockedExternalFetches++;
    return Promise.reject(new Error('EXTERNAL_PROVIDER_FETCH_DISABLED_FOR_UI_FIXTURE_TEST'));
  }
  return originalFetch(input, ...options);
};
let mongo, connection, models, server, browser, page, heartbeat;
async function check(name, operation) {
  await operation(); report.checks.push({name, passed: true}); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE4_UI_CHECK_PASSED', name}) + '\n');
}
async function data(response, status = 200) {
  assert.equal(response.status(), status, 'Unexpected API status');
  return (await response.json()).data;
}
async function mutate(context, method, route, body = {}) {
  const proof = await data(await context.get(origin + '/api/v1/auth/csrf'));
  return context.fetch(origin + '/api/v1' + route, {method, headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken}, data: body});
}

try {
  await fs.access(path.join(root, 'apps/web/dist/index.html'));
  mongo = await startLocalMongo({directory: path.join(output, 'mongodb'), port: databasePort, replicaSet: 'phase4UiCheck'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  await models.QueueState.create({_id: 'generation-capacity', activeCount: 0, runningJobId: null, workerId: 'ui-fixture-heartbeat-only', workerHeartbeatAt: new Date()});
  heartbeat = setInterval(() => {
    models.QueueState.updateOne({_id: 'generation-capacity', workerId: 'ui-fixture-heartbeat-only'}, {$set: {workerHeartbeatAt: new Date()}}).catch(() => {});
  }, 5000);
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, planner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(String(error.message).slice(0, 300)));
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/v1\/(?:projects\/[^/]+\/generations|generations\/[^/]+\/retry)(?:\?|$)/u.test(request.url())) report.generationAdmissionCalls++;
  });
  await page.goto(origin + '/signup');
  await page.getByLabel('Your name', {exact: true}).fill('UI Flow Review');
  await page.getByLabel('Email address', {exact: true}).fill(`ui-check-${Date.now()}@example.test`);
  await page.getByLabel('Password', {exact: true}).fill('A clear story deserves careful review. 42');
  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(page).toHaveURL(/\/app$/u);
  const user = await data(await context.request.get(origin + '/api/v1/auth/me'));
  const project = await data(await mutate(context.request, 'POST', '/projects', {
    title: 'Script revision and settings regression', prompt: 'Explain the JavaScript event loop for beginners.',
    settings: {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'},
  }), 201);
  const projectId = project.id;
  const reviewUrl = origin + `/app/projects/${projectId}/review`;
  report.projectId = projectId;
  let storyboard, approved, syntheticJob;

  await check('Injected fixture planner creates a real saved draft without provider or render calls', async () => {
    await page.goto(reviewUrl);
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/storyboards/generate'));
    await page.getByRole('button', {name: 'Generate script', exact: true}).click();
    storyboard = await data(await response, 201);
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveValue(fixture.scenes[0].narration);
    assert.equal(storyboard.status, 'DRAFT');
    assert.equal(report.fixturePlannerCalls, 1);
    assert.equal(await models.GenerationJob.countDocuments(), 0);
  });

  const localNarration = 'Local edit kept. ' + fixture.scenes[0].narration;
  const savedNarration = 'Saved remote revision. ' + fixture.scenes[0].narration;
  await check('Real revision conflict preserves local narration and offers the saved comparison', async () => {
    await page.getByLabel('Scene 1 narration', {exact: true}).fill(localNarration);
    const remoteScenes = structuredClone(storyboard.scenes);
    remoteScenes[0].narration = savedNarration;
    const remote = await data(await mutate(context.request, 'PATCH', `/projects/${projectId}/storyboards/${storyboard.id}`, {expectedRevision: storyboard.revision, scenes: remoteScenes}));
    assert.equal(remote.revision, storyboard.revision + 1);
    const response = page.waitForResponse(value => value.request().method() === 'PATCH' && value.url().endsWith(`/storyboards/${storyboard.id}`));
    await page.getByRole('button', {name: 'Save changes', exact: true}).click();
    assert.equal((await response).status(), 409);
    await expect(page.getByRole('heading', {name: 'The saved revision changed.', exact: true})).toBeVisible();
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveValue(localNarration);
    await page.getByText('Compare with saved narration', {exact: true}).click();
    await expect(page.locator('.comparison-scene').first()).toContainText(savedNarration);
    await page.screenshot({path: path.join(output, 'conflict-local-edit-preserved.png'), fullPage: true});
  });

  await check('Reload confirmation keeps edits on dismissal and discards only after explicit confirmation', async () => {
    await page.getByRole('button', {name: 'Reload saved revision', exact: true}).click();
    let dialog = page.getByRole('dialog', {name: 'Discard local script edits?', exact: true});
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', {name: 'Keep it', exact: true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveValue(localNarration);
    await page.getByRole('button', {name: 'Reload saved revision', exact: true}).click();
    dialog = page.getByRole('dialog', {name: 'Discard local script edits?', exact: true});
    await dialog.getByRole('button', {name: 'Reload saved draft', exact: true}).click();
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveValue(savedNarration);
    await expect(page.getByRole('button', {name: 'Approve script', exact: true})).toBeEnabled();
    await expect(page.getByRole('heading', {name: 'The saved revision changed.', exact: true})).toHaveCount(0);
  });

  await check('Separate approval freezes the saved revision; no render is submitted', async () => {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/approve'));
    await page.getByRole('button', {name: 'Approve script', exact: true}).click();
    approved = await data(await response);
    assert.equal(approved.status, 'APPROVED');
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toBeDisabled();
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toBeEnabled();
    assert.equal(await models.GenerationJob.countDocuments(), 0);
  });

  await check('Delete confirmation is truthful and the real PROJECT_BUSY guard rejects a synthetic active-state fixture', async () => {
    // This row only exercises the deletion guard. No admission route is called,
    // no reservation/lease is created, and no worker exists for this database.
    const storedStoryboard = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/storyboards/current`));
    const stored = await models.Storyboard.findById(storedStoryboard.id).lean();
    syntheticJob = await models.GenerationJob.create({ownerId: user.user.id, projectId, storyboardId: storedStoryboard.id, approvedRevision: storedStoryboard.revision, status: 'QUEUED', stage: null, progress: {completedStages: 0, totalStages: 6}, attempt: 0, snapshot: storedStoryboard, storyboardHash: stored.contentHash});
    report.syntheticQueuedJobFixture = true;
    await models.Project.updateOne({_id: projectId}, {$set: {phase: 'RENDERING', activeGenerationId: syntheticJob._id, latestGenerationId: syntheticJob._id}});
    await page.goto(origin + '/app/projects');
    await page.getByRole('button', {name: `Delete ${project.title}`, exact: true}).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Finish or cancel any active generation before deleting.');
    await expect(dialog).not.toContainText('Active generation work will be cancelled.');
    const response = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url().endsWith(`/projects/${projectId}`));
    await dialog.getByRole('button', {name: 'Delete project', exact: true}).click();
    const denied = await response;
    assert.equal(denied.status(), 409);
    assert.equal((await denied.json()).error.code, 'PROJECT_BUSY');
    await expect(dialog.getByRole('alert')).toBeVisible();
    assert.equal((await models.Project.findById(projectId).lean()).deletedAt, null);
    await dialog.getByRole('button', {name: 'Keep it', exact: true}).click();
    await models.GenerationJob.updateOne({_id: syntheticJob._id}, {$set: {status: 'CANCELLED', cancelledAt: new Date()}});
    await models.Project.updateOne({_id: projectId}, {$set: {phase: 'REVIEW', activeGenerationId: null}});
  });

  await check('Changing approved project duration clears current selection/editor and requires a new generated draft', async () => {
    const before = await models.Storyboard.findById(approved.id).lean();
    await page.goto(reviewUrl);
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toBeEnabled();
    await page.getByText('Saved idea & project settings', {exact: true}).click();
    await page.getByLabel('Target duration', {exact: true}).selectOption('60');
    const response = page.waitForResponse(value => value.request().method() === 'PATCH' && value.url().endsWith(`/projects/${projectId}`));
    await page.getByRole('button', {name: 'Save project settings', exact: true}).click();
    const updated = await data(await response);
    assert.equal(updated.settings.durationSec, 60);
    assert.equal(updated.currentStoryboardId, null);
    await expect(page.getByRole('button', {name: 'Generate script', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toHaveCount(0);
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveCount(0);
    await expect(page.getByRole('status').filter({hasText: 'Project settings saved.'})).toContainText('Generate a new script');
    assert.equal((await context.request.get(origin + `/api/v1/projects/${projectId}/storyboards/current`)).status(), 404);
    const after = await models.Storyboard.findById(approved.id).lean();
    assert.equal(after.status, 'APPROVED'); assert.equal(after.contentHash, before.contentHash); assert.equal(after.revision, before.revision);
    await page.reload();
    await expect(page.getByRole('button', {name: 'Generate script', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toHaveCount(0);
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveCount(0);
    assert.equal(report.fixturePlannerCalls, 1, 'A settings change must not silently call a provider.');
    await page.screenshot({path: path.join(output, 'settings-require-new-script.png'), fullPage: true});
  });

  await check('Idle deletion succeeds only after confirmation and revokes project reads', async () => {
    await page.goto(origin + '/app/projects');
    await page.getByRole('button', {name: `Delete ${project.title}`, exact: true}).click();
    const dialog = page.getByRole('dialog');
    const response = page.waitForResponse(value => value.request().method() === 'DELETE' && value.url().endsWith(`/projects/${projectId}`));
    await dialog.getByRole('button', {name: 'Delete project', exact: true}).click();
    assert.equal((await response).status(), 202);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', {name: project.title, exact: true})).toHaveCount(0);
    assert.ok((await models.Project.findById(projectId).lean()).deletedAt);
    assert.equal((await context.request.get(origin + `/api/v1/projects/${projectId}`)).status(), 404);
  });

  assert.equal(report.generationAdmissionCalls, 0, 'This fixture UI check must not submit a render.');
  assert.equal(report.blockedExternalFetches, 0, 'No provider fetch should even be attempted.');
  assert.equal(report.browserErrors.length, 0, 'No uncaught browser errors.');
  assert.equal(await models.GenerationJob.countDocuments({status: {$in: ['PROCESSING', 'COMPLETED']}}), 0, 'No job was processed.');
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).slice(0, 1500)};
  process.stderr.write(JSON.stringify({event: 'PHASE4_UI_CHECK_FAILED', ...report.failure, reportPath: path.join(output, 'report.json')}) + '\n');
  process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  globalThis.fetch = originalFetch;
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE4_UI_CHECK_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
