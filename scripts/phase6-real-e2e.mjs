import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import mongoose from 'mongoose';
import {chromium, expect} from '@playwright/test';
import {startLocalMongo} from './local-mongo.mjs';
import {loadConfig} from '../apps/api/src/config.js';
import {createMongoRepository} from '../apps/api/src/repository.js';
import {createStudioModels, initializeStudioModels} from '../apps/api/src/studio-models.js';
import {createApp} from '../apps/api/src/app.js';
import {buildDashboardRouter} from '../apps/api/src/dashboard.js';
import {buildStudioRouter} from '../apps/api/src/studio.js';
import {createGeminiAssistant} from '../apps/api/src/assistant/provider.js';
import {createGeminiPlanner} from '../apps/api/src/projects/planner.js';
import {canonicalHash} from '../packages/video-engine/src/contracts.js';

// This test intentionally makes real Gemini calls: two chat turns and one
// storyboard request, with the providers' bounded retry policies unchanged.
const root = fileURLToPath(new URL('../', import.meta.url));
const resumedFrom = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (resumedFrom && (!resumedFrom.startsWith(path.join(root, 'artifacts/phase6') + path.sep) || !/^real-e2e-\d+$/u.test(path.basename(resumedFrom)))) throw new Error('Use an owned previous real assistant test directory.');
const previous = resumedFrom ? JSON.parse(await fs.readFile(path.join(resumedFrom, 'report.json'), 'utf8')) : null;
const runId = 'real-e2e-' + Date.now();
const output = path.join(root, 'artifacts/phase6', runId);
const privateRunId = previous?.privateRunId || (resumedFrom ? path.basename(resumedFrom) : runId);
if (!/^real-e2e-\d+$/u.test(privateRunId)) throw new Error('Invalid private test workspace.');
const privateRoot = path.join(root, 'var/phase6-tests', privateRunId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), mode: 'REAL_GEMINI_BROWSER_MONGODB', resumedFrom, privateRunId, realGemini: true, realRender: false, cloudHttpRequests: 0, assistantTurns: 0, storyboardCalls: 0, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const freePort = () => new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const databasePort = previous?.databasePort || await freePort(), apiPort = await freePort();
const origin = `http://127.0.0.1:${apiPort}`;
report.databasePort = databasePort; report.apiPort = apiPort;
const config = {...loadConfig({NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase6_real?replicaSet=phase6Real`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash', MAIL_TRANSPORT: 'disabled', PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')}), authRateLimit: 100};
if (!config.geminiApiKey) throw new Error('Configure server-side Gemini before the real assistant test.');
report.model = config.geminiModel;
const providerFetch = async (url, options) => {
  assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
  assert.equal(url.includes(config.geminiApiKey), false); assert.equal(options.body.includes(config.geminiApiKey), false);
  report.cloudHttpRequests++; await save();
  return fetch(url, options);
};
const actualAssistant = createGeminiAssistant(config, {fetchImpl: providerFetch});
const actualPlanner = createGeminiPlanner(config, {fetchImpl: providerFetch});
let mongo, connection, repository, models, server, browser, page, projectId, ownerId;
let capturedContext;
const initialIdea = 'Help me plan a video.';
const clarification = 'Make a 60-second English explainer about the water cycle for children aged ten. Use a puddle drying in sunlight as the example. Please suggest 60 seconds; I will apply that setting myself.';
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE6_REAL_CHECK_PASSED', name}) + '\n');}
async function data(response, status = 200) {const payload = await response.json(); assert.equal(response.status(), status, 'Unexpected API status' + (payload.error?.code ? ': ' + payload.error.code : '')); return payload.data;}
async function startApi() {
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const assistant = async request => {report.assistantTurns++; return actualAssistant(request);};
  const planner = async request => {report.storyboardCalls++; capturedContext = {conversationRevision: request.conversationRevision, messages: structuredClone(request.conversation), settings: structuredClone(request.settings)}; const candidate = await actualPlanner(request); await fs.writeFile(path.join(output, 'planner-candidate.json'), JSON.stringify(candidate, null, 2)); return candidate;};
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, assistant, planner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize();
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
}

try {
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: databasePort, replicaSet: 'phase6Real'});
  await startApi();
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(String(error.message).replaceAll(config.geminiApiKey, '[REDACTED]').slice(0, 300)));
  if (!previous) {
  await check('Dashboard explicitly saves the idea and opens its owned assistant without a hidden provider call', async () => {
    await page.goto(origin + '/signup');
    await page.getByLabel('Your name', {exact: true}).fill('Real Assistant Review');
    await page.getByLabel('Email address', {exact: true}).fill(`real-assistant-${Date.now()}@example.test`);
    await page.getByLabel('Password', {exact: true}).fill('A clear conversation deserves careful review. 42');
    await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
    const me = await data(await context.request.get(origin + '/api/v1/auth/me')); ownerId = me.user.id;
    await page.getByLabel('What would you like to explain?', {exact: true}).fill(initialIdea);
    await page.getByRole('button', {name: 'Save idea & start chat', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/projects\/[a-f0-9]{24}\/assistant$/u); projectId = page.url().match(/projects\/([a-f0-9]{24})/u)[1]; report.projectId = projectId;
    await expect(page.getByLabel('Message the AI assistant', {exact: true})).toHaveValue(initialIdea);
    assert.equal(report.assistantTurns, 0); assert.equal(await models.AssistantMessage.countDocuments({projectId}), 0);
  });
  await check('Real Gemini asks clarifying questions for the vague idea and saves the complete turn', async () => {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/assistant/messages'), {timeout: 115000});
    await page.getByRole('button', {name: 'Send message', exact: true}).click(); const reply = await data(await response);
    assert.ok(reply.missingInformation.length >= 1, 'The vague topic produces a real clarifying question');
    for (const question of reply.missingInformation) assert.ok(reply.assistantMessage.includes(question));
    assert.equal(reply.conversationRevision, 2);
    await expect(page.getByRole('article', {name: 'Assistant, message 2', exact: true})).toContainText(reply.assistantMessage);
    report.firstReply = reply;
  });
  await check('A real follow-up remembers context and proposes sixty seconds without saving that suggestion', async () => {
    await page.getByLabel('Message the AI assistant', {exact: true}).fill(clarification);
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/assistant/messages'), {timeout: 115000});
    await page.getByRole('button', {name: 'Send message', exact: true}).click(); const reply = await data(await response);
    assert.equal(reply.conversationRevision, 4); assert.equal(reply.suggestedSettings.durationSec, 60);
    assert.match(reply.assistantMessage, /water|puddle|evaporat|cycle/iu);
    assert.equal((await data(await context.request.get(origin + '/api/v1/projects/' + projectId))).settings.durationSec, 30);
    await expect(page.getByRole('button', {name: 'Apply suggested settings', exact: true})).toBeEnabled();
    report.secondReply = reply;
    await page.screenshot({path: path.join(output, 'real-conversation.png'), fullPage: true});
  });
  await check('Explicit acceptance changes settings; complete conversation survives a real API/database-connection restart', async () => {
    await page.getByRole('button', {name: 'Apply suggested settings', exact: true}).click();
    await expect.poll(async () => (await data(await context.request.get(origin + '/api/v1/projects/' + projectId))).settings.durationSec).toBe(60);
    const before = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages`));
    assert.equal(before.messages.length, 4); assert.deepEqual(before.messages.map(message => message.conversationRevision), [1, 2, 3, 4]);
    await new Promise(resolve => server.close(resolve)); server = null; await connection.close(); connection = null;
    await startApi(); await page.reload();
    await expect(page.getByRole('article', {name: 'Assistant, message 4', exact: true})).toBeVisible();
    const after = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages`));
    assert.deepEqual(after, before); assert.equal((await models.AssistantUsageBucket.findOne({ownerId}).lean()).count, 2);
    assert.equal(report.assistantTurns, 2);
    await fs.writeFile(path.join(output, 'saved-history.json'), JSON.stringify(after, null, 2));
  });
  } else {
    await check('The existing real conversation and explicitly saved settings are restored without another assistant call', async () => {
      projectId = previous.projectId; report.projectId = projectId;
      const project = await models.Project.findById(projectId).lean(); assert.ok(project && !project.deletedAt); ownerId = String(project.ownerId);
      const user = await repository.findUserById(ownerId); assert.ok(user);
      await page.goto(origin + '/login'); await page.getByLabel('Email address', {exact: true}).fill(user.emailNormalized);
      await page.getByLabel('Password', {exact: true}).fill('A clear conversation deserves careful review. 42');
      await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
      await page.goto(origin + `/app/projects/${projectId}/assistant`);
      await expect(page.getByRole('article', {name: 'Assistant, message 4', exact: true})).toBeVisible();
      const history = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/assistant/messages`));
      assert.equal(history.messages.length, 4); assert.equal(project.settings.durationSec, 60); assert.equal(report.assistantTurns, 0);
      await fs.writeFile(path.join(output, 'saved-history.json'), JSON.stringify(history, null, 2));
    });
  }
  await check('Real storyboard planning uses the saved clarification with an immutable conversation provenance record', async () => {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/storyboards/generate'), {timeout: 150000});
    await page.getByRole('button', {name: 'Generate script', exact: true}).click(); const draft = await data(await response, 201);
    await expect(page).toHaveURL(/\/review$/u); assert.equal(draft.status, 'DRAFT'); assert.equal(draft.targetDurationSec, 60);
    assert.equal(capturedContext.conversationRevision, 4); assert.equal(capturedContext.messages.length, 4); assert.ok(capturedContext.messages.some(message => message.content === clarification));
    assert.match(draft.scenes.map(scene => scene.narration).join(' '), /water|evaporat|puddle|condensat/iu);
    const stored = await models.Storyboard.findById(draft.id).lean(); assert.equal(stored.sourceConversationRevision, 4); assert.equal(stored.sourceConversationHash, canonicalHash({conversationRevision: 4, messages: capturedContext.messages}));
    assert.equal(await models.GenerationJob.countDocuments(), 0); assert.equal(draft.approvedAt, null);
    await fs.writeFile(path.join(output, 'real-storyboard.json'), JSON.stringify(draft, null, 2));
    await page.screenshot({path: path.join(output, 'real-storyboard-review.png'), fullPage: true});
    report.storyboardId = draft.id; report.storyboardTargetDurationSec = draft.targetDurationSec; report.storyboardScenes = draft.scenes.length;
  });
  assert.equal(report.browserErrors.length, 0); report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(config.geminiApiKey, '[REDACTED]').slice(0, 1800)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE6_REAL_FAILED', ...report.failure}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE6_REAL_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
