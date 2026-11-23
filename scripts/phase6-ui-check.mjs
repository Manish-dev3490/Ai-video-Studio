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
import {cleanupAssistantHistory} from '../apps/api/src/assistant/index.js';
import {ApiError} from '../apps/api/src/http.js';

// Explicit fixture integration test. The UI, database, auth, history, receipts
// and settings mutations are real. Assistant/planner outputs are injected data;
// this command never calls Gemini, TTS, a render worker or generation admission.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `ui-check-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase6', runId);
const privateRoot = path.join(root, 'var/phase6-tests', runId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), mode: 'FIXTURE_ASSISTANT_REAL_MONGO_BROWSER', realGemini: false, realTts: false, realRender: false, realWorker: false, fixtureAssistantCalls: 0, fixturePlannerCalls: 0, generationAdmissionCalls: 0, blockedExternalFetches: 0, blockedBrowserExternalRequests: 0, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const port = () => new Promise((resolve, reject) => {const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const databasePort = await port(), apiPort = await port();
const origin = `http://127.0.0.1:${apiPort}`;
const config = {...loadConfig({NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase6_ui_check?replicaSet=phase6UiCheck`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), GEMINI_API_KEY: '', GOOGLE_API_KEY: '', MAIL_TRANSPORT: 'disabled', PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')}), authRateLimit: 100, assistantRateLimit: 100};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {report.blockedExternalFetches++; return Promise.reject(new Error('EXTERNAL_FETCH_DISABLED_FOR_ASSISTANT_FIXTURE_QA'));}
  return originalFetch(input, ...options);
};
const plannerInputs = [];
const assistant = async ({project, history, message}) => {
  report.fixtureAssistantCalls++;
  assert.ok(project.prompt && Array.isArray(history));
  if (message === 'Trigger recoverable provider failure') throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Fixture-only internal diagnostic must not be reflected.');
  if (history.length === 0) return {assistantMessage: 'I can help shape a short explainer.', suggestedSettings: {}, missingInformation: ['What topic should the video explain?', 'Who is the intended audience?']};
  if (/ninety/iu.test(message)) return {assistantMessage: 'We can expand the water-cycle explanation to ninety seconds. Apply the duration only if you want it saved.', suggestedSettings: {durationSec: 90}, missingInformation: []};
  return {assistantMessage: 'A water-cycle explainer for children can follow evaporation, clouds and rain. Use a raindrop as the example. You can explicitly apply a sixty-second duration.', suggestedSettings: {durationSec: 60}, missingInformation: []};
};
const planner = async input => {
  report.fixturePlannerCalls++; plannerInputs.push(structuredClone({conversation: input.conversation, conversationRevision: input.conversationRevision, settings: input.settings}));
  const fixture = JSON.parse(await fs.readFile(path.join(root, `packages/video-engine/fixtures/event-loop-${input.settings.durationSec}.json`), 'utf8'));
  return {schemaVersion: fixture.schemaVersion, targetDurationSec: fixture.targetDurationSec, scenes: fixture.scenes};
};
let mongo, connection, models, server, browser, page;
let context, projectId, ownerId, approvedId, savedRequestKey;
const qaPassword = 'A careful assistant story stays private. 42';
const lostMessage = 'Use a raindrop example.';
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE6_UI_CHECK_PASSED', name}) + '\n');}
async function data(response, expected = 200) {const body = await response.json(); assert.equal(response.status(), expected, 'Unexpected API status' + (body.error?.code ? ': ' + body.error.code : '')); return body.data;}
async function mutate(request, method, route, body = {}, headers = {}) {const proof = await data(await request.get(origin + '/api/v1/auth/csrf')); return request.fetch(origin + '/api/v1' + route, {method, headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken, ...headers}, data: body});}
const articles = () => page.getByRole('log', {name: 'Saved conversation', exact: true}).getByRole('article');
async function send(message, expected = 200) {
  await page.getByLabel('Message the AI assistant', {exact: true}).fill(message);
  const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/assistant/messages'));
  await page.getByRole('button', {name: 'Send message', exact: true}).click();
  const reply = await response; assert.equal(reply.status(), expected); return expected === 200 ? data(reply) : null;
}
async function quota() {return (await models.AssistantUsageBucket.findOne({ownerId}).lean())?.count ?? 0;}

try {
  await fs.access(path.join(root, 'apps/web/dist/index.html'));
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: databasePort, replicaSet: 'phase6UiCheck'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, planner, assistant}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize();
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  await context.route('**/*', route => {const target = new URL(route.request().url()); if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return route.continue(); report.blockedBrowserExternalRequests++; return route.abort();});
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message.replaceAll(qaPassword, '[REDACTED]').slice(0, 500)));
  page.on('request', request => {if (request.method() === 'POST' && /\/api\/v1\/(?:projects\/[^/]+\/generations|generations\/[^/]+\/retry)(?:\?|$)/u.test(request.url())) report.generationAdmissionCalls++;});
  await page.goto(origin + '/signup');
  await page.getByLabel('Your name', {exact: true}).fill('Assistant UI Review'); await page.getByLabel('Email address', {exact: true}).fill(`assistant-ui-${Date.now()}@example.test`); await page.getByLabel('Password', {exact: true}).fill(qaPassword);
  await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
  ownerId = (await data(await context.request.get(origin + '/api/v1/auth/me'))).user.id;

  await check('Dashboard saves an owned idea and a vague first message receives persisted clarifying questions', async () => {
    await page.getByLabel('What would you like to explain?', {exact: true}).fill('Make a video.');
    await page.getByRole('button', {name: 'Save idea & start chat', exact: true}).click(); await expect(page).toHaveURL(/\/app\/projects\/[a-f0-9]{24}\/assistant$/u);
    projectId = page.url().match(/projects\/([a-f0-9]{24})/u)[1]; report.projectId = projectId;
    await expect(page.getByLabel('Message the AI assistant', {exact: true})).toHaveValue('Make a video.');
    const reply = await send('Make a video.'); assert.equal(reply.conversationRevision, 2); assert.equal(reply.missingInformation.length, 2);
    await expect(articles()).toHaveCount(2); await expect(page.getByRole('article', {name: 'Assistant, message 2', exact: true})).toContainText('What topic should the video explain?');
    assert.equal(await quota(), 1); assert.equal((await models.Project.findById(projectId).lean()).settings.durationSec, 30);
  });

  await check('Follow-up answers survive reload and suggested duration changes only after explicit application', async () => {
    await send('Explain the water cycle for ten-year-olds in a sixty-second English video.'); await expect(articles()).toHaveCount(4);
    assert.equal((await models.Project.findById(projectId).lean()).settings.durationSec, 30);
    await page.reload(); await expect(articles()).toHaveCount(4); await expect(page.getByRole('article', {name: 'You, message 3', exact: true})).toContainText('water cycle');
    await expect(page.getByRole('button', {name: 'Apply suggested settings', exact: true})).toBeEnabled();
    await page.screenshot({path: path.join(output, 'saved-clarification-thread.png'), fullPage: true});
    await page.getByRole('button', {name: 'Apply suggested settings', exact: true}).click();
    await expect.poll(async () => (await models.Project.findById(projectId).lean()).settings.durationSec).toBe(60);
    assert.equal(report.fixtureAssistantCalls, 2); assert.equal(await quota(), 2);
  });

  await check('A lost response after commit is recovered with the same replay key and no duplicate quota/provider work', async () => {
    let lost = false, replayHeader = false, originalKey;
    const pattern = '**/api/v1/assistant/messages';
    const handler = async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const body = request.postDataJSON();
      if (body.message === lostMessage && !lost) {
        originalKey = await request.headerValue('idempotency-key'); const response = await route.fetch(); assert.equal(response.status(), 200); lost = true; await route.abort('failed'); return;
      }
      if (body.message === lostMessage && lost) {assert.equal(await request.headerValue('idempotency-key'), originalKey); replayHeader = await request.headerValue('x-assistant-replay-only') === 'true';}
      return route.continue();
    };
    await page.route(pattern, handler);
    await page.getByLabel('Message the AI assistant', {exact: true}).fill(lostMessage); await page.getByRole('button', {name: 'Send message', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Check saved reply', exact: true})).toBeVisible(); await expect(page.getByLabel('Message the AI assistant', {exact: true})).toHaveValue(lostMessage);
    assert.equal(await models.AssistantMessage.countDocuments({projectId}), 6); assert.equal(report.fixtureAssistantCalls, 3); assert.equal(await quota(), 3);
    await page.getByRole('button', {name: 'Check saved reply', exact: true}).click();
    await expect(page.getByLabel('Message the AI assistant', {exact: true})).toHaveValue(''); await expect(articles()).toHaveCount(6);
    assert.equal(replayHeader, true); assert.equal(report.fixtureAssistantCalls, 3); assert.equal(await quota(), 3); savedRequestKey = originalKey;
    await page.unroute(pattern, handler);
    report.lostResponseRecovery = {sameKey: true, replayOnly: true, providerCallsForTurn: 1, savedPairCount: 1, quotaChargesForTurn: 1};
  });

  await check('A known provider failure keeps the draft, exposes no private diagnostic and saves no partial pair', async () => {
    await send('Trigger recoverable provider failure', 503);
    await expect(page.getByRole('alert')).toContainText('unavailable'); await expect(page.getByLabel('Message the AI assistant', {exact: true})).toHaveValue('Trigger recoverable provider failure');
    await expect(page.getByRole('button', {name: 'Check saved reply', exact: true})).toHaveCount(0); await expect(articles()).toHaveCount(6);
    assert.equal(await models.AssistantMessage.countDocuments({projectId}), 6); assert.equal(report.fixtureAssistantCalls, 4); assert.equal(await quota(), 4);
    assert.equal((await page.locator('body').innerText()).includes('Fixture-only internal diagnostic'), false);
    await page.screenshot({path: path.join(output, 'recoverable-assistant-error.png'), fullPage: true});
    await page.getByLabel('Message the AI assistant', {exact: true}).fill('');
  });

  await check('Generating a fixture draft receives saved conversation context; a later explicit change preserves old approval', async () => {
    await page.getByRole('button', {name: 'Generate script', exact: true}).click(); await expect(page).toHaveURL(/\/review$/u);
    assert.equal(report.fixturePlannerCalls, 1); assert.equal(plannerInputs[0].conversationRevision, 6); assert.equal(plannerInputs[0].settings.durationSec, 60);
    assert.equal(plannerInputs[0].conversation.length, 6); assert.ok(plannerInputs[0].conversation.some(turn => turn.content.includes('water cycle'))); assert.ok(!plannerInputs[0].conversation.some(turn => turn.content === 'Trigger recoverable provider failure'));
    const approvalResponse = page.waitForResponse(response => response.request().method() === 'POST' && /\/storyboards\/[^/]+\/approve$/u.test(response.url()));
    await page.getByRole('button', {name: 'Approve script', exact: true}).click(); await data(await approvalResponse); await expect(page.getByRole('heading', {name: 'Approved revision 1', exact: true})).toBeVisible(); await expect(page.getByLabel('Scene 1 narration', {exact: true})).toBeDisabled();
    const before = await models.Project.findById(projectId).lean(); approvedId = before.currentStoryboardId; const approved = await models.Storyboard.findById(approvedId).lean(); assert.equal(approved.status, 'APPROVED'); assert.equal(approved.sourceConversationRevision, 6);
    await page.getByRole('link', {name: 'Chat with AI', exact: true}).click(); await send('Please make it ninety seconds.'); await expect(articles()).toHaveCount(8);
    assert.equal((await models.Project.findById(projectId).lean()).settings.durationSec, 60); assert.equal(String((await models.Project.findById(projectId).lean()).currentStoryboardId), String(approvedId));
    await page.getByRole('button', {name: 'Apply suggested settings', exact: true}).click(); await expect.poll(async () => (await models.Project.findById(projectId).lean()).settings.durationSec).toBe(90);
    const after = await models.Project.findById(projectId).lean(); assert.equal(after.currentStoryboardId, null); assert.equal(after.phase, 'DRAFT');
    const historical = await models.Storyboard.findById(approvedId).lean(); assert.equal(historical.status, 'APPROVED'); assert.equal(historical.contentHash, approved.contentHash); assert.deepEqual(historical.scenes, approved.scenes);
    await page.getByRole('link', {name: 'Review script', exact: true}).click(); await expect(page.getByRole('button', {name: 'Generate script', exact: true})).toBeVisible(); await expect(page.getByLabel('Scene 1 narration', {exact: true})).toHaveCount(0);
    await page.getByRole('link', {name: 'Chat with AI', exact: true}).click(); await expect(articles()).toHaveCount(8);
  });

  await check('History is paginated chronologically with private fields omitted and cursor/owner checks enforced', async () => {
    const first = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages?limit=3`)); assert.deepEqual(first.messages.map(message => message.conversationRevision), [1, 2, 3]); assert.ok(first.nextCursor);
    const second = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`)); assert.deepEqual(second.messages.map(message => message.conversationRevision), [4, 5, 6]);
    for (const message of [...first.messages, ...second.messages]) assert.ok(Object.keys(message).every(key => ['id', 'role', 'content', 'conversationRevision', 'createdAt', 'suggestedSettings'].includes(key)));
    assert.equal((await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages?cursor=${encodeURIComponent(first.nextCursor + 'x')}`)).status(), 400);
    const other = await browser.newContext(); await data(await mutate(other.request, 'POST', '/auth/signup', {displayName: 'Other Assistant Owner', email: `assistant-other-${Date.now()}@example.test`, password: qaPassword}), 201);
    assert.equal((await other.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages`)).status(), 404);
    assert.equal((await mutate(other.request, 'POST', '/assistant/messages', {projectId, message: lostMessage}, {'Idempotency-Key': savedRequestKey, 'X-Assistant-Replay-Only': 'true'})).status(), 404); await other.close();
  });

  await check('Credential-shaped input is blocked before project/chat storage or provider calls, and chat fits mobile', async () => {
    await page.setViewportSize({width: 390, height: 844}); await expect(page.getByLabel('Message the AI assistant', {exact: true})).toBeVisible(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: path.join(output, 'mobile-chat.png'), fullPage: true}); await page.setViewportSize({width: 1440, height: 1000});
    const fakeCredential = 'AIza' + 'x'.repeat(35), beforeProjects = await models.Project.countDocuments({ownerId}), beforeCalls = report.fixtureAssistantCalls, beforeQuota = await quota();
    await page.getByLabel('Message the AI assistant', {exact: true}).fill(fakeCredential); await expect(page.getByRole('button', {name: 'Send message', exact: true})).toBeDisabled(); await page.getByLabel('Message the AI assistant', {exact: true}).fill('');
    assert.equal((await mutate(context.request, 'POST', '/assistant/messages', {projectId, message: fakeCredential}, {'Idempotency-Key': randomUUID()})).status(), 422);
    assert.equal((await mutate(context.request, 'POST', '/projects', {title: 'Rejected credential topic', prompt: fakeCredential, settings: {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'}})).status(), 422);
    await page.goto(origin + '/app'); await page.getByLabel('What would you like to explain?', {exact: true}).fill(fakeCredential); await page.getByRole('button', {name: 'Save idea & start chat', exact: true}).click(); await expect(page.getByRole('alert')).toContainText('credential'); await page.getByLabel('What would you like to explain?', {exact: true}).fill('');
    assert.equal(await models.Project.countDocuments({ownerId}), beforeProjects); assert.equal(await models.AssistantMessage.countDocuments({projectId}), 8); assert.equal(report.fixtureAssistantCalls, beforeCalls); assert.equal(await quota(), beforeQuota);
    assert.equal(await models.Project.countDocuments({prompt: fakeCredential}), 0); assert.equal(await models.AssistantMessage.countDocuments({content: fakeCredential}), 0);
  });

  await check('Project deletion revokes history and receipt replay immediately, then erases saved conversation data', async () => {
    const before = report.fixtureAssistantCalls; await data(await mutate(context.request, 'DELETE', `/projects/${projectId}`), 202);
    assert.equal((await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages`)).status(), 404);
    assert.equal((await mutate(context.request, 'POST', '/assistant/messages', {projectId, message: lostMessage}, {'Idempotency-Key': savedRequestKey, 'X-Assistant-Replay-Only': 'true'})).status(), 404);
    await cleanupAssistantHistory({models}); assert.equal(await models.AssistantMessage.countDocuments({projectId}), 0); assert.equal(await models.AssistantRequest.countDocuments({projectId}), 0); assert.equal(report.fixtureAssistantCalls, before);
  });

  assert.equal(report.browserErrors.length, 0); assert.equal(report.blockedExternalFetches, 0); assert.equal(report.blockedBrowserExternalRequests, 0); assert.equal(report.generationAdmissionCalls, 0); assert.equal(await models.GenerationJob.countDocuments(), 0);
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(qaPassword, '[REDACTED]').replace(/AIza[A-Za-z0-9_-]{35}/gu, '[FAKE_CREDENTIAL_REDACTED]').slice(0, 1800)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE6_UI_CHECK_FAILED', ...report.failure}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  globalThis.fetch = originalFetch;
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE6_UI_CHECK_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
