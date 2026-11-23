import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import mongoose from 'mongoose';
import {chromium, expect} from '@playwright/test';
import {startLocalMongo} from './local-mongo.mjs';
import {loadConfig} from '../apps/api/src/config.js';
import {createMongoRepository} from '../apps/api/src/repository.js';
import {createStudioModels, initializeStudioModels} from '../apps/api/src/studio-models.js';
import {createApp} from '../apps/api/src/app.js';
import {buildDashboardRouter} from '../apps/api/src/dashboard.js';
import {buildStudioRouter} from '../apps/api/src/studio.js';
import {createGeminiPlanner} from '../apps/api/src/projects/planner.js';
import {parseWebVtt, validateWebVtt} from '../packages/video-engine/src/captions.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let duration = 30, prior = null, savedScript = null;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--duration') duration = Number(args[++index]);
  else if (args[index] === '--resume') prior = path.resolve(args[++index]);
  else if (args[index] === '--saved-script') savedScript = path.resolve(args[++index]);
  else throw new Error('Use --duration 30|60|90 [--resume PHASE8_RUN_DIRECTORY].');
}
if (![30, 60, 90].includes(duration) || prior && (!prior.startsWith(path.join(root, 'artifacts/phase8') + path.sep) || !/^render-\d+-[a-f0-9]{8}$/u.test(path.basename(prior)))) throw new Error('Invalid Phase8 test options.');
const runId = `render-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase8', runId);
await fs.mkdir(output, {recursive: true});
const state = prior ? JSON.parse(await fs.readFile(path.join(prior, 'qa-state.json'), 'utf8')) : {duration, privateRoot: path.join(root, 'var/phase8-tests', runId), email: `phase8-${Date.now()}@example.test`};
state.savedScript ??= savedScript;
if (state.savedScript && (!state.savedScript.startsWith(path.join(root, 'artifacts/phase8') + path.sep) || !state.savedScript.endsWith('.json'))) throw new Error('Reviewed scripts must be explicit Phase8 QA artifacts.');
const allowedPrivate = path.join(root, 'var/phase8-tests') + path.sep;
if (state.duration !== duration || !state.privateRoot.startsWith(allowedPrivate)) throw new Error('Resume state does not match the duration or test workspace.');
const report = {phase: 8, startedAt: new Date().toISOString(), duration, resumedFrom: prior, realGemini: !state.savedScript, reviewedScriptSource: state.savedScript, fixturePlanning: Boolean(state.savedScript), realKokoroRemotion: true, checks: [], attempts: [], providerRequests: 0, browserErrors: [], passed: false};
const save = async () => {await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await fs.writeFile(path.join(output, 'qa-state.json'), JSON.stringify(state, null, 2) + '\n');};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => {const value = net.createServer(); value.listen(0, '127.0.0.1', () => {const number = value.address().port; value.close(() => resolve(number));});});
state.databasePort ??= await port();
const apiPort = await port(), origin = `http://127.0.0.1:${apiPort}`;
const environment = {...process.env, NODE_ENV: 'test', MAIL_TRANSPORT: 'disabled', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${state.databasePort}/phase8_e2e?replicaSet=phase8Test`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), PRIVATE_STORAGE_ROOT: path.join(state.privateRoot, 'media'), WORKER_WORK_ROOT: path.join(state.privateRoot, 'jobs')};
const config = {...loadConfig(environment), authRateLimit: 100, planningRateLimit: 100};
if (!config.geminiApiKey && !state.savedScript) throw new Error('Configure server-side Gemini before running real Phase8 validation.');
const password = 'Each careful explanation needs a measured voice. 42';
const topics = {30: ['How rain forms', 'Explain how water evaporates, forms clouds and falls as rain for young learners.'], 60: ['The JavaScript event loop', 'Explain the JavaScript event loop for beginners using one simple example: synchronous work, a waiting callback, and the call stack.'], 90: ['How a seed becomes a plant', 'Explain seed germination and early plant growth for beginners: water uptake, root growth, the shoot, leaves and photosynthesis. Use clear everyday language and avoid unsupported precise numbers.']};
let connection, mongo, models, server, worker, browser, page, context, workerLog = '';
let storyboard, generation, persisted;
async function check(name, work) {await work(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE8_CHECK_PASSED', duration, name}) + '\n');}
async function data(response, status = 200) {const body = await response.json(); assert.equal(response.status(), status, body.error?.code || 'Unexpected HTTP status'); return body.data;}
async function authenticatedGet(url, options = {}) {let response = await context.request.get(url, options); if (response.status() === 401) {await pause(500); response = await context.request.get(url, options);} return response;}
async function terminal(id) {
  let previous = '', lastHeartbeat = 0;
  const deadline = Date.now() + Object.values(config.workerStageTimeoutMs[duration]).reduce((sum, value) => sum + value, 120000);
  while (Date.now() < deadline) {
    const current = await data(await authenticatedGet(origin + '/api/v1/generations/' + id));
    const label = current.status + ':' + current.stage;
    if (label !== previous || Date.now() - lastHeartbeat > 30000) {previous = label; lastHeartbeat = Date.now(); process.stdout.write(JSON.stringify({event: 'PHASE8_RENDER_PROGRESS', duration, generationId: id, status: current.status, stage: current.stage}) + '\n');}
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(current.status)) return current;
    if (worker.exitCode !== null) throw new Error('The isolated worker stopped unexpectedly.');
    await pause(2000);
  }
  throw new Error('Real render exceeded its measured stage budgets.');
}
await save();
try {
  mongo = await startLocalMongo({directory: path.join(state.privateRoot, 'mongodb'), port: state.databasePort, replicaSet: 'phase8Test'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const actualPlanner = createGeminiPlanner(config, {fetchImpl: async (...parameters) => {
    report.providerRequests++; await save(); const response = await fetch(...parameters);
    if (response.status === 429) {
      const details = await response.clone().json().catch(() => ({}));
      report.providerQuota = (details.error?.details || []).flatMap(item => item.violations ? item.violations.map(value => ({quotaId: String(value.quotaId || '').replace(/[^A-Za-z0-9_./-]/gu, '').slice(0, 200), quotaValue: String(value.quotaValue || '').replace(/[^0-9.]/gu, '').slice(0, 20)})) : item.retryDelay ? [{retryDelay: String(item.retryDelay).replace(/[^0-9.s]/gu, '').slice(0, 20)}] : []);
      await save();
    }
    return response;
  }});
  const planner = state.savedScript ? async input => {
    if (input.durationRevision) throw new Error('Saved-script validation does not simulate an AI duration revision.');
    const source = JSON.parse(await fs.readFile(state.savedScript, 'utf8'));
    assert.equal(source.targetDurationSec, duration);
    return {schemaVersion: 1, targetDurationSec: duration, scenes: structuredClone(source.scenes)};
  } : actualPlanner;
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, planner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize();
  server = await new Promise((resolve, reject) => {const value = app.listen(apiPort, '127.0.0.1', () => resolve(value)); value.once('error', reject);});
  const workerEnvironment = {...environment};
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'RESEND_API_KEY', 'MAIL_ENCRYPTION_SECRET']) delete workerEnvironment[key];
  worker = fork(path.join(root, 'apps/worker/src/main.js'), [], {cwd: path.join(root, 'apps/worker'), env: workerEnvironment, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const record = bytes => {workerLog = (workerLog + bytes.toString()).slice(-512000);}; worker.stdout.on('data', record); worker.stderr.on('data', record);
  await expect.poll(async () => Boolean((await models.QueueState.findById('generation-capacity').lean())?.workerId), {timeout: 30000}).toBe(true);
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', acceptDownloads: true});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 300)));
  await page.goto(origin + (prior ? '/login' : '/signup'));
  if (!prior) await page.getByLabel('Your name', {exact: true}).fill('Phase Eight Quality');
  await page.getByLabel('Email address', {exact: true}).fill(state.email); await page.getByLabel('Password', {exact: true}).fill(password);
  await page.getByRole('button', {name: prior ? 'Sign in' : 'Create account', exact: true}).click(); await expect(page).toHaveURL(/\/app$/u);
  if (!state.projectId) {
    await check('Dashboard saves a topic-specific project with the requested duration', async () => {
      await page.getByRole('link', {name: 'Create video', exact: true}).click();
      await page.getByLabel('Project title', {exact: true}).fill(state.savedScript ? 'Reviewed JavaScript event loop' : topics[duration][0]);
      await page.getByLabel('What would you like to explain?', {exact: true}).fill((state.savedScript ? 'Explain the JavaScript event loop using the explicitly reviewed saved script for local rendering validation.' : topics[duration][1]) + ` Create a ${duration}-second English educational explainer with short, readable visual labels. Use STEPS for cycles. Any FLOWCHART must be a simple forward chain of two to four nodes.`);
      await page.getByRole('group', {name: 'Target video duration', exact: true}).getByRole('button', {name: `${duration}s`, exact: true}).click();
      await page.getByRole('button', {name: 'Save project', exact: true}).click(); await expect(page).toHaveURL(/\/projects\/[a-f0-9]{24}\/review$/u);
      state.projectId = page.url().match(/projects\/([a-f0-9]{24})/u)[1];
    });
  } else await page.goto(origin + `/app/projects/${state.projectId}/review`);
  const projectId = state.projectId;
  let existing = await models.Project.findById(projectId).lean();
  if (!existing.currentStoryboardId) {
    await check(state.savedScript ? 'Explicit reviewed-script fixture becomes an editable draft; no Gemini request' : 'Real Gemini produces a supported editable storyboard', async () => {
      for (let retry = 0; retry < 3; retry++) {
        const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/storyboards/generate'), {timeout: 150000});
        await page.getByRole('button', {name: 'Generate script', exact: true}).click(); const value = await response;
        if (value.status() === 201) {storyboard = await data(value, 201); break;}
        const error = await value.json(); report.attempts.push({kind: 'PLANNING_REJECTION', code: error.error?.code}); await save();
        if (error.error?.code !== 'AI_INVALID_OUTPUT' || retry === 2) throw new Error('Real storyboard planning failed: ' + error.error?.code);
        await expect(page.getByRole('button', {name: 'Generate script', exact: true})).toBeEnabled();
      }
      await fs.writeFile(path.join(output, 'initial-draft.json'), JSON.stringify(storyboard, null, 2));
    });
  } else storyboard = await data(await authenticatedGet(origin + `/api/v1/projects/${projectId}/storyboards/current`));
  for (let correction = 0; correction <= 2; correction++) {
    const latest = await models.GenerationJob.findOne({projectId, storyboardId: storyboard.id}).sort({createdAt: -1}).lean();
    if (latest?.status === 'COMPLETED') {generation = await data(await authenticatedGet(origin + '/api/v1/generations/' + latest._id)); break;}
    if (!latest) {
      await page.goto(origin + `/app/projects/${projectId}/review`);
      if (storyboard.status !== 'APPROVED') {
        await expect(page.getByRole('button', {name: 'Approve script', exact: true})).toBeEnabled();
        const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/approve'));
        await page.getByRole('button', {name: 'Approve script', exact: true}).click(); await data(await response);
        storyboard = await data(await authenticatedGet(origin + `/api/v1/projects/${projectId}/storyboards/current`));
      }
      await fs.writeFile(path.join(output, `approved-${correction}.json`), JSON.stringify(storyboard, null, 2));
      await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toBeEnabled({timeout: 30000});
      const response = page.waitForResponse(value => value.request().method() === 'POST' && /\/generations$/u.test(value.url()));
      await page.getByRole('button', {name: 'Start rendering', exact: true}).click();
      const admitted = await data(await response, 202); state.generationId = admitted.generationId; await save();
    } else {state.generationId = String(latest._id); await page.goto(origin + `/app/projects/${projectId}/generating?generation=${latest._id}`);}
    const completed = await terminal(state.generationId);
    report.attempts.push({generationId: completed.id, storyboardId: storyboard.id, status: completed.status, errorCode: completed.error?.code ?? null}); await save();
    if (completed.status === 'COMPLETED') {generation = completed; break;}
    if (completed.error?.code !== 'DURATION_REVISION_REQUIRED' || correction === 2) throw new Error('Actual render failed: ' + completed.error?.code);
    if (state.savedScript) throw new Error('Reviewed-script timing needs manual review; no cloud fallback is permitted in this test mode.');
    await check(`Measured timing creates an explicit corrected draft with fresh approval (${correction + 1})`, async () => {
      const feedback = await data(await authenticatedGet(origin + `/api/v1/generations/${completed.id}/narration-feedback`)); assert.equal(feedback.available, true);
      await fs.writeFile(path.join(output, `duration-feedback-${correction}.json`), JSON.stringify(feedback, null, 2));
      await expect(page.getByRole('button', {name: 'Revise narration to fit', exact: true})).toBeEnabled({timeout: 15000});
      await page.screenshot({path: path.join(output, `measured-duration-feedback-${correction}.png`), fullPage: true});
      const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/storyboards/revise-duration'), {timeout: 150000});
      await page.getByRole('button', {name: 'Revise narration to fit', exact: true}).click(); const next = await data(await response, 201);
      assert.equal(next.status, 'DRAFT'); assert.equal(next.parentStoryboardId, storyboard.id); assert.notEqual(next.id, storyboard.id);
      const original = await models.Storyboard.findById(storyboard.id).lean(); assert.equal(original.status, 'APPROVED'); assert.deepEqual(original.scenes, storyboard.scenes);
      assert.equal((await models.Reservation.findOne({generationId: completed.id}).lean()).state, 'RELEASED');
      assert.equal(await models.GenerationJob.countDocuments({storyboardId: next.id}), 0);
      storyboard = next; await expect(page).toHaveURL(/\/review/u);
    });
  }
  assert.ok(generation && generation.status === 'COMPLETED');
  persisted = await models.GenerationJob.findById(generation.id).lean();
  await check('Fresh worker output passes media, audio, duration and quota validation', async () => {
    assert.equal(persisted.manifest.validation.passed, true); assert.ok(Object.values(persisted.manifest.validation.checks).every(Boolean));
    assert.deepEqual(persisted.snapshot.scenes, storyboard.scenes); assert.ok(persisted.renderStartedAt);
    assert.equal(persisted.manifest.speech.speed, 1); assert.equal(persisted.manifest.speech.offline, true); assert.equal(persisted.manifest.speech.voice, 'af_heart');
    assert.equal((await models.Reservation.findOne({generationId: generation.id})).state, 'CONSUMED');
    report.engine = {timings: persisted.manifest.timings, validation: persisted.manifest.validation, speech: persisted.manifest.speech};
    await fs.writeFile(path.join(output, 'worker-manifest.json'), JSON.stringify(persisted.manifest, null, 2));
    await fs.writeFile(path.join(output, 'approved-storyboard.json'), JSON.stringify(storyboard, null, 2));
  });
  await validatePlayback();
  assert.equal(report.browserErrors.length, 0); report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(config.geminiApiKey, '[REDACTED]').slice(0, 1500)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE8_FAILED', ...report.failure, reportPath: path.join(output, 'report.json')}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (worker) {if (worker.connected) worker.send({type: 'AVS_WORKER_STOP'}); for (let count = 0; count < 100 && worker.exitCode === null; count++) await pause(100); if (worker.exitCode === null) worker.kill();}
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {}); if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString(); await save(); await fs.writeFile(path.join(output, 'worker.log'), workerLog.replaceAll(config.geminiApiKey, '[REDACTED]'));
  process.stdout.write(JSON.stringify({event: 'PHASE8_COMPLETED', duration, passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}

async function validatePlayback() {
  await check('Private media downloads and browser captions match the measured timeline', async () => {
    const video = await data(await authenticatedGet(origin + '/api/v1/assets/' + generation.outputAssetId));
    const captions = await data(await authenticatedGet(origin + '/api/v1/assets/' + generation.captionAssetId));
    assert.equal(video.availability, 'AVAILABLE'); assert.equal(video.expiresAt, captions.expiresAt); assert.ok(Math.abs(video.durationSec - duration) <= 5.000001);
    const videoUrl = origin + `/api/v1/assets/${video.id}/download`, captionUrl = origin + `/api/v1/assets/${captions.id}/download`;
    const bytes = await (await authenticatedGet(videoUrl)).body(), text = await (await authenticatedGet(captionUrl)).text();
    const timeline = persisted.manifest.render.timeline; validateWebVtt({timeline, text, language: 'en'}); const cues = parseWebVtt(text);
    await fs.writeFile(path.join(output, 'video.mp4'), bytes); await fs.writeFile(path.join(output, 'captions.vtt'), text);
    assert.equal((await authenticatedGet(videoUrl, {headers: {Range: 'bytes=0-31'}})).status(), 206);
    await page.goto(origin + `/app/projects/${state.projectId}/preview?generation=${generation.id}`);
    await expect(page.locator('video')).toBeVisible(); await expect.poll(() => page.locator('video').evaluate(element => element.readyState)).toBeGreaterThanOrEqual(1);
    assert.ok(Math.abs(await page.locator('video').evaluate(element => element.duration) - video.durationSec) < .15);
    await page.getByLabel('English captions', {exact: true}).check(); await page.locator('video').evaluate(element => element.play());
    await expect.poll(() => page.locator('video').evaluate(element => element.currentTime)).toBeGreaterThan(.1); await page.locator('video').evaluate(element => element.pause());
    await expect.poll(() => page.locator('video').evaluate(element => element.textTracks[0]?.cues?.length || 0)).toBe(cues.length);
    for (const cue of cues) {await page.locator('video').evaluate((element, seconds) => {element.currentTime = seconds;}, (cue.startMs + cue.endMs) / 2000); await expect.poll(() => page.locator('video').evaluate(element => element.textTracks[0]?.activeCues?.[0]?.startTime ?? -1)).toBeCloseTo(cue.startMs / 1000, 2);}
    for (const [index, scene] of timeline.scenes.entries()) {await page.locator('video').evaluate((element, seconds) => {element.currentTime = seconds;}, (scene.startFrame + scene.durationInFrames * .55) / 30); await expect.poll(() => page.locator('video').evaluate(element => element.seeking)).toBe(false); await page.locator('video').screenshot({path: path.join(output, `scene-${index + 1}.png`)});}
    await page.screenshot({path: path.join(output, 'video-preview.png'), fullPage: true});
    for (const [label, expected] of [['Download MP4', bytes], ['Download captions', Buffer.from(text)]]) {const waiting = page.waitForEvent('download'); await page.getByRole('button', {name: label, exact: true}).click(); const download = await waiting; assert.equal(await download.failure(), null); const file = path.join(output, label === 'Download MP4' ? 'browser-video.mp4' : 'browser-captions.vtt'); await download.saveAs(file); assert.deepEqual(await fs.readFile(file), expected);}
    report.output = {generationId: generation.id, requestedDurationSec: duration, actualDurationSec: video.durationSec, videoBytes: bytes.length, videoSha256: createHash('sha256').update(bytes).digest('hex'), captionCueCount: cues.length, sceneCount: timeline.scenes.length};
  });
}
