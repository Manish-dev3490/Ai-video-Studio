import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
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
import {cleanupExpiredMedia} from '../apps/api/src/media.js';
import {createGeminiPlanner} from '../apps/api/src/projects/planner.js';
import {parseWebVtt, validateWebVtt} from '../packages/video-engine/src/captions.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let resumeArgument = null;
let selectedDuration = null;
let reviewNarration = false;
const argumentsList = process.argv.slice(2);
for (let index = 0; index < argumentsList.length; index++) {
  const argument = argumentsList[index];
  if (argument === '--duration' && selectedDuration === null) {
    selectedDuration = Number(argumentsList[++index]);
    if (![30, 60, 90].includes(selectedDuration)) throw new Error('Use --duration 30, 60 or 90.');
  } else if (argument === '--review-narration' && !reviewNarration) reviewNarration = true;
  else if (!argument.startsWith('--') && resumeArgument === null) resumeArgument = argument;
  else throw new Error('Usage: phase4-e2e.mjs [prior-run-directory] [--duration 30|60|90] [--review-narration]');
}
const resumedFrom = resumeArgument ? path.resolve(resumeArgument) : null;
const runId = 'e2e-' + Date.now();
const output = path.join(root, 'artifacts/phase4', runId);
if (resumedFrom && (!resumedFrom.startsWith(path.join(root, 'artifacts/phase4') + path.sep) || !/^e2e-\d+$/u.test(path.basename(resumedFrom)))) throw new Error('Invalid prior test run.');
let priorApproval = null;
if (resumedFrom) {
  try {priorApproval = JSON.parse(await fs.readFile(path.join(resumedFrom, 'approved-storyboard.json'), 'utf8'));}
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // A verification assertion can stop after real approval but before writing
    // its artifact. The live owner-scoped API must confirm that approval below.
    priorApproval = JSON.parse(await fs.readFile(path.join(resumedFrom, 'gemini-draft.json'), 'utf8'));
  }
}
const durationSec = priorApproval?.targetDurationSec ?? selectedDuration ?? 30;
if (![30, 60, 90].includes(durationSec) || (selectedDuration !== null && selectedDuration !== durationSec)) throw new Error('Requested duration must match the preserved approval.');
const privateRoot = path.join(root, 'var/phase4-tests', resumedFrom ? path.basename(resumedFrom) : runId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), requestedDurationSec: durationSec, realGemini: !resumedFrom, resumedFrom, realKokoroRemotion: true, checks: [], passed: false, stages: [], browserErrors: []};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise((resolve, reject) => {const listener = net.createServer(); listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {const p = listener.address().port; listener.close(() => resolve(p));});});
let databasePort = await port();
if (resumedFrom) {
  const lines = (await fs.readFile(path.join(resumedFrom, 'mongodb/mongod.log'), 'utf8')).split('\n').flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}});
  databasePort = lines.find(line => Number.isSafeInteger(line.attr?.options?.net?.port))?.attr.options.net.port;
  if (!databasePort) throw new Error('Prior dedicated database port is unavailable.');
}
const apiPort = await port();
report.databasePort = databasePort;
const origin = `http://127.0.0.1:${apiPort}`;
const environment = {...process.env, NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase4_e2e?replicaSet=phase4Test`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')};
const config = {...loadConfig(environment), authRateLimit: 100};
if (!config.geminiApiKey) throw new Error('Configure server-side GEMINI_API_KEY before the real end-to-end test.');
let mongo, connection, models, server, worker, browser;
let page;
let workerLog = '';
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE4_CHECK_PASSED', name}) + '\n');}
async function data(response, status = 200) {
  const payload = await response.json();
  assert.equal(response.status(), status, `Unexpected API status${payload.error?.code ? ': ' + payload.error.code + ' — ' + payload.error.message : ''}`);
  return payload.data;
}
async function post(context, route, body = {}, extra = {}) {
  const proof = await data(await context.get(origin + '/api/v1/auth/csrf'));
  return context.post(origin + '/api/v1' + route, {headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken, ...extra}, data: body});
}
async function authenticatedGet(context, url, options) {
  // The real dashboard's polling performs cookie renewal. Allow its bounded
  // single-flight refresh to finish if this independent observer hits expiry.
  let response = await context.get(url, options);
  for (let attempt = 0; response.status() === 401 && attempt < 20; attempt++) {
    await pause(1000);
    response = await context.get(url, options);
  }
  return response;
}
try {
  mongo = await startLocalMongo({directory: path.join(resumedFrom || output, 'mongodb'), port: databasePort, replicaSet: 'phase4Test'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection);
  await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const actualGeminiPlanner = createGeminiPlanner(config);
  const recordedActualPlanner = async input => {
    const generated = await actualGeminiPlanner(input);
    await fs.writeFile(path.join(output, 'provider-storyboard.json'), JSON.stringify(generated, null, 2));
    return generated;
  };
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models, planner: recordedActualPlanner}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  server = await new Promise((resolve, reject) => {const instance = app.listen(apiPort, '127.0.0.1', () => resolve(instance)); instance.once('error', reject);});
  const workerEnvironment = {...environment}; delete workerEnvironment.GEMINI_API_KEY; delete workerEnvironment.GOOGLE_API_KEY;
  worker = fork(path.join(root, 'apps/worker/src/main.js'), [], {cwd: path.join(root, 'apps/worker'), env: workerEnvironment, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const rememberWorker = chunk => {workerLog = (workerLog + chunk.toString()).slice(-256000);};
  worker.stdout.on('data', rememberWorker); worker.stderr.on('data', rememberWorker);
  await check('Separate worker registers a live heartbeat on a real MongoDB replica set', async () => {
    await expect.poll(async () => Boolean((await models.QueueState.findById('generation-capacity').lean())?.workerId), {timeout: 30000}).toBe(true);
  });
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce', acceptDownloads: true});
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 300)));
  let projectId, storyboard, generationId, completed, persistedJob, captionCues;
  if (!resumedFrom) {
  const email = 'phase4-' + Date.now() + '@example.test';
  await page.goto(origin + '/signup');
  await page.getByLabel('Your name', {exact: true}).fill('Phase Four Review');
  await page.getByLabel('Email address', {exact: true}).fill(email);
  await page.getByLabel('Password', {exact: true}).fill('Every little story deserves a scene. 42');
  await page.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(page).toHaveURL(/\/app$/u);
  await check('Browser saves a real project and restores it from MongoDB', async () => {
    await page.getByRole('link', {name: 'Create video', exact: true}).click();
    await page.getByLabel('Project title', {exact: true}).fill('The JavaScript event loop');
    const narrationWords = {30: 66, 60: 134, 90: 200}[durationSec];
    await page.getByLabel('What would you like to explain?', {exact: true}).fill(`Explain the JavaScript event loop clearly for beginners, using a simple visual example. Make a ${durationSec}-second educational video with short readable visual labels. Write approximately ${narrationWords} spoken words in total across the narration fields only; count narration separately from visual labels. Use the full narration budget so the explanation is not too short, and keep the language simple.`);
    const durationButton = page.getByRole('group', {name: 'Target video duration', exact: true}).getByRole('button', {name: `${durationSec}s`, exact: true});
    await expect(durationButton).toBeEnabled();
    await durationButton.click();
    await expect(durationButton).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', {name: 'Save project', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/projects\/[a-f0-9]{24}\/review$/u);
    projectId = page.url().match(/projects\/([a-f0-9]{24})/u)[1];
    await page.reload();
    await expect(page.getByRole('heading', {name: 'The JavaScript event loop', exact: true})).toBeVisible();
    const saved = await models.Project.findById(projectId).lean();
    assert.equal(saved.settings.durationSec, durationSec);
    assert.ok(saved.prompt.includes('event loop'));
  });
  await check('Real Gemini generates a schema-validated draft displayed in the scene editor', async () => {
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/storyboards/generate'), {timeout: 150000});
    await page.getByRole('button', {name: 'Generate script', exact: true}).click();
    storyboard = await data(await response, 201);
    assert.equal(storyboard.status, 'DRAFT'); assert.ok(storyboard.scenes.length >= 2);
    assert.equal(storyboard.targetDurationSec, durationSec);
    assert.equal(storyboard.settingsSnapshot.durationSec, durationSec);
    await expect(page.getByLabel('Scene 1 narration', {exact: true})).toBeVisible();
    await fs.writeFile(path.join(output, 'gemini-draft.json'), JSON.stringify(storyboard, null, 2));
    await page.screenshot({path: path.join(output, 'storyboard-review.png'), fullPage: true});
  });
  if (reviewNarration) {
    const reviewPath = path.join(output, 'review-edits.json');
    report.awaitingNarrationReview = reviewPath;
    await save();
    process.stdout.write(JSON.stringify({event: 'NARRATION_REVIEW_READY', draftPath: path.join(output, 'gemini-draft.json'), editsPath: reviewPath}) + '\n');
    let review;
    const reviewDeadline = Date.now() + 900000;
    while (Date.now() < reviewDeadline) {
      try {review = JSON.parse(await fs.readFile(reviewPath, 'utf8')); break;}
      catch (error) {if (error.code !== 'ENOENT') throw error; await pause(500);}
    }
    assert.ok(review && Array.isArray(review.edits), 'An explicit reviewer supplies complete narration edits before approval');
    await check('Dashboard saves explicit reviewer narration edits before approving the new revision', async () => {
      for (const edit of review.edits) {
        assert.ok(Number.isInteger(edit.sceneIndex) && edit.sceneIndex >= 0 && edit.sceneIndex < storyboard.scenes.length && typeof edit.narration === 'string' && edit.narration.trim());
        await page.getByLabel(`Scene ${edit.sceneIndex + 1} narration`, {exact: true}).fill(edit.narration);
      }
      if (review.edits.length) {
        const response = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith(`/storyboards/${storyboard.id}`));
        await page.getByRole('button', {name: 'Save changes', exact: true}).click();
        storyboard = await data(await response);
        for (const edit of review.edits) assert.equal(storyboard.scenes[edit.sceneIndex].narration, edit.narration);
      }
      report.reviewerNarrationEdits = review.edits.length;
      delete report.awaitingNarrationReview;
      await fs.writeFile(path.join(output, 'reviewed-draft.json'), JSON.stringify(storyboard, null, 2));
    });
  }
  await check(durationSec === 30 ? 'Dirty edits require save; saved revision is approved separately and becomes immutable' : 'The saved real Gemini draft is explicitly approved and becomes immutable', async () => {
    const narration = page.getByLabel('Scene 1 narration', {exact: true});
    if (durationSec === 30) {
      await narration.fill('Now, ' + storyboard.scenes[0].narration);
      await expect(page.getByRole('button', {name: 'Approve script', exact: true})).toBeDisabled();
      await page.getByRole('button', {name: 'Save changes', exact: true}).click();
    }
    await expect(page.getByRole('button', {name: 'Approve script', exact: true})).toBeEnabled();
    const approval = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/approve'));
    await page.getByRole('button', {name: 'Approve script', exact: true}).click();
    assert.equal((await data(await approval)).status, 'APPROVED');
    await expect(narration).toBeDisabled();
    storyboard = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/storyboards/current`));
    const denied = await post(context.request, `/projects/${projectId}/storyboards/${storyboard.id}/approve`, {expectedRevision: storyboard.revision + 1});
    assert.equal(denied.status(), 409);
    await fs.writeFile(path.join(output, 'approved-storyboard.json'), JSON.stringify(storyboard, null, 2));
  });
  await check('Dashboard submits the exact approved revision to a background job', async () => {
    await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toBeEnabled({timeout: 30000});
    const admission = page.waitForResponse(r => r.request().method() === 'POST' && /\/generations$/u.test(r.url()));
    await page.getByRole('button', {name: 'Start rendering', exact: true}).click();
    const accepted = await data(await admission, 202); generationId = accepted.generationId;
    await expect(page).toHaveURL(/\/generating\?generation=/u);
    const job = await models.GenerationJob.findById(generationId).lean();
    assert.equal(job.approvedRevision, storyboard.revision);
    assert.equal(job.snapshot.id, storyboard.id);
    assert.deepEqual(job.snapshot.scenes, storyboard.scenes);
    await page.screenshot({path: path.join(output, 'background-progress.png'), fullPage: true});
  });
  } else {
    storyboard = priorApproval;
    projectId = storyboard.projectId;
    const user = await repository.models.User.findOne({displayName: 'Phase Four Review'}).lean();
    if (!user) throw new Error('Prior isolated test user is unavailable.');
    await page.goto(origin + '/login');
    await page.getByLabel('Email address', {exact: true}).fill(user.emailNormalized);
    await page.getByLabel('Password', {exact: true}).fill('Every little story deserves a scene. 42');
    await page.getByRole('button', {name: 'Sign in', exact: true}).click();
    await expect(page).toHaveURL(/\/app$/u);
    const currentApproval = await data(await context.request.get(origin + `/api/v1/projects/${projectId}/storyboards/current`));
    assert.equal(currentApproval.id, priorApproval.id);
    assert.equal(currentApproval.status, 'APPROVED');
    assert.equal(currentApproval.targetDurationSec, durationSec);
    assert.deepEqual(currentApproval.scenes, priorApproval.scenes);
    storyboard = currentApproval;
    await fs.writeFile(path.join(output, 'approved-storyboard.json'), JSON.stringify(storyboard, null, 2));
    const failed = await models.GenerationJob.findOne({projectId, status: 'FAILED'}).sort({createdAt: -1}).lean();
    if (!failed) {
    await check('Dashboard continues the preserved real Gemini approval with its first background admission', async () => {
      assert.equal(await models.GenerationJob.countDocuments({projectId}), 0, 'Continuation never duplicates an existing admission');
      await page.goto(origin + `/app/projects/${projectId}/review`);
      const button = page.getByRole('button', {name: 'Start rendering', exact: true});
      await expect(button).toBeEnabled({timeout: 30000});
      const response = page.waitForResponse(r => r.request().method() === 'POST' && /\/generations$/u.test(r.url()));
      await button.click();
      const admission = await data(await response, 202); generationId = admission.generationId;
      const job = await models.GenerationJob.findById(generationId).lean();
      assert.equal(job.approvedRevision, storyboard.revision);
      assert.deepEqual(job.snapshot.scenes, storyboard.scenes);
      await page.screenshot({path: path.join(output, 'background-progress.png'), fullPage: true});
    });
    } else {
    await check('Browser retries the prior failed publication with the same real Gemini approval and a new job/reservation', async () => {
      if (!failed?.error?.retryable) throw new Error('Prior job is not eligible for a legitimate retry.');
      await page.goto(origin + `/app/projects/${projectId}/generating?generation=${failed._id}`);
      const button = page.getByRole('button', {name: 'Retry generation', exact: true});
      await expect(button).toBeEnabled({timeout: 30000});
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/retry'));
      await button.click();
      const admission = await data(await response, 202); generationId = admission.generationId;
      const job = await models.GenerationJob.findById(generationId).lean();
      assert.ok(String(job._id) !== String(failed._id));
      assert.equal(String(job.retryOf), String(failed._id));
      assert.deepEqual(job.snapshot.scenes, storyboard.scenes);
      assert.equal((await models.Reservation.findOne({generationId: failed._id}).lean()).state, 'RELEASED');
      await page.screenshot({path: path.join(output, 'background-progress.png'), fullPage: true});
    });
    }
  }
  await check('Real local Kokoro and Remotion complete a fresh worker render', async () => {
    const deadline = Date.now() + Object.values(config.workerStageTimeoutMs[durationSec]).reduce((sum, value) => sum + value, 120000);
    let previous;
    while (Date.now() < deadline) {
      const current = await data(await authenticatedGet(context.request, origin + '/api/v1/generations/' + generationId));
      const stage = current.status + ':' + current.stage;
      if (stage !== previous) {previous = stage; report.stages.push({at: new Date().toISOString(), status: current.status, stage: current.stage}); await save(); process.stdout.write(JSON.stringify({event: 'REAL_RENDER_PROGRESS', status: current.status, stage: current.stage}) + '\n');}
      if (current.status === 'COMPLETED') {completed = current; break;}
      if (['FAILED', 'CANCELLED'].includes(current.status)) throw new Error('Actual worker render terminated: ' + (current.error?.code || current.status));
      if (worker.exitCode !== null) throw new Error('Worker exited before the render completed.');
      await pause(2000);
    }
    assert.ok(completed, 'Render completed before its benchmark-derived test deadline');
    assert.ok(completed.outputAssetId && completed.captionAssetId);
    persistedJob = await models.GenerationJob.findById(generationId).lean();
    assert.ok(persistedJob.renderStartedAt, 'Actual render handoff recorded durably');
    assert.equal(persistedJob.snapshot.targetDurationSec, durationSec);
    assert.equal(persistedJob.manifest.validation.passed, true);
    assert.ok(Object.values(persistedJob.manifest.validation.checks).every(Boolean));
    assert.equal(persistedJob.manifest.speech.provider, 'KOKORO');
    assert.equal(persistedJob.manifest.speech.offline, true);
    report.engine = {timingsSeconds: persistedJob.manifest.timings, validation: persistedJob.manifest.validation, speech: {provider: persistedJob.manifest.speech.provider, offline: persistedJob.manifest.speech.offline, execution: persistedJob.manifest.speech.execution}};
    const reserved = await models.Reservation.findOne({generationId}).lean(); assert.equal(reserved.state, 'CONSUMED');
    await fs.writeFile(path.join(output, 'worker-manifest.json'), JSON.stringify(persistedJob.manifest, null, 2));
    await fs.writeFile(path.join(output, 'completed-generation.json'), JSON.stringify(completed, null, 2));
  });
  await check('Owned video/captions stream correctly; range and cross-owner guards apply', async () => {
    const video = await data(await context.request.get(origin + '/api/v1/assets/' + completed.outputAssetId));
    const captions = await data(await context.request.get(origin + '/api/v1/assets/' + completed.captionAssetId));
    assert.equal(video.availability, 'AVAILABLE'); assert.equal(captions.availability, 'AVAILABLE'); assert.equal(video.expiresAt, captions.expiresAt);
    assert.ok(Math.abs(video.durationSec - durationSec) <= 5 + 0.000001);
    assert.ok(!JSON.stringify(video).includes('storage'));
    const url = origin + '/api/v1/assets/' + completed.outputAssetId + '/download';
    const range = await context.request.get(url, {headers: {Range: 'bytes=0-31'}}); assert.equal(range.status(), 206); assert.equal((await range.body()).length, 32);
    assert.equal((await context.request.get(url, {headers: {Range: 'bytes=999999999-'}})).status(), 416);
    const full = await context.request.get(url); assert.equal(full.status(), 200);
    const bytes = await full.body(); assert.equal(bytes.length, video.sizeBytes);
    const vtt = await context.request.get(origin + '/api/v1/assets/' + completed.captionAssetId + '/download');
    const vttText = await vtt.text();
    validateWebVtt({timeline: persistedJob.manifest.render.timeline, text: vttText, language: 'en'});
    captionCues = parseWebVtt(vttText);
    await fs.writeFile(path.join(output, 'video.mp4'), bytes);
    await fs.writeFile(path.join(output, 'captions.vtt'), await vtt.body());
    const other = await browser.newContext();
    await data(await post(other.request, '/auth/signup', {displayName: 'Other Owner', email: 'other-' + Date.now() + '@example.test', password: 'This separate owner has no private media.'}), 201);
    assert.equal((await other.request.get(url)).status(), 404);
    assert.equal((await other.request.get(origin + '/api/v1/projects/' + projectId)).status(), 404);
    await other.close();
    report.output = {generationId, actualDurationSec: video.durationSec, requestedDurationSec: durationSec, videoBytes: bytes.length, videoSha256: createHash('sha256').update(bytes).digest('hex'), captionCueCount: captionCues.length, pairedExpiry: video.expiresAt};
  });
  await check('Browser preview plays actual media and exposes synchronized selectable captions/downloads', async () => {
    await page.goto(origin + `/app/projects/${projectId}/preview?generation=${generationId}`);
    await expect(page.locator('video')).toBeVisible();
    await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
    const browserDuration = await page.locator('video').evaluate(video => video.duration);
    assert.ok(Math.abs(browserDuration - report.output.actualDurationSec) < 0.15);
    await page.getByLabel('English captions', {exact: true}).check();
    await page.locator('video').evaluate(video => video.play());
    await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.1);
    await page.locator('video').evaluate(video => video.pause());
    await expect.poll(() => page.locator('video').evaluate(video => video.textTracks[0]?.mode)).toBe('showing');
    await expect.poll(() => page.locator('video').evaluate(video => video.textTracks[0]?.cues?.length || 0)).toBe(captionCues.length);
    for (const [index, cue] of captionCues.entries()) {
      await page.locator('video').evaluate((video, seconds) => {video.currentTime = seconds;}, (cue.startMs + cue.endMs) / 2000);
      await expect.poll(() => page.locator('video').evaluate(video => video.textTracks[0]?.activeCues?.[0]?.startTime ?? -1)).toBeCloseTo(cue.startMs / 1000, 2);
      if (index === 0 || index === Math.floor(captionCues.length / 2) || index === captionCues.length - 1) await page.screenshot({path: path.join(output, `video-scene-${index + 1}.png`), fullPage: true});
    }
    await page.getByLabel('English captions', {exact: true}).uncheck();
    await expect.poll(() => page.locator('video').evaluate(video => video.textTracks[0]?.mode)).toBe('hidden');
    await page.getByLabel('English captions', {exact: true}).check();
    await page.screenshot({path: path.join(output, 'video-preview.png'), fullPage: true});
    for (const label of ['Download MP4', 'Download captions']) {
      const event = page.waitForEvent('download'); await page.getByRole('button', {name: label, exact: true}).click(); const download = await event; assert.equal(await download.failure(), null);
      const name = label === 'Download MP4' ? 'video.mp4' : 'captions.vtt';
      const downloaded = path.join(output, 'browser-' + name);
      await download.saveAs(downloaded);
      assert.deepEqual(await fs.readFile(downloaded), await fs.readFile(path.join(output, name)));
    }
  });
  await check('Expiry blocks new reads while historical completion and project data remain', async () => {
    await models.MediaAsset.updateMany({generationId}, {$set: {expiresAt: new Date(Date.now() - 1000)}});
    assert.equal((await context.request.get(origin + '/api/v1/assets/' + completed.outputAssetId + '/download')).status(), 404);
    assert.equal((await data(await context.request.get(origin + '/api/v1/assets/' + completed.outputAssetId))).availability, 'EXPIRED');
    assert.equal((await data(await context.request.get(origin + '/api/v1/generations/' + generationId))).status, 'COMPLETED');
    await cleanupExpiredMedia({models, config});
    assert.equal(await models.MediaAsset.countDocuments({generationId, status: 'DELETED'}), 2);
  });
  assert.equal(report.browserErrors.length, 0);
  report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(config.geminiApiKey, '[REDACTED]').slice(0, 1500)};
  process.stderr.write(JSON.stringify({event: 'PHASE4_E2E_FAILED', ...report.failure, reportPath: path.join(output, 'report.json')}) + '\n');
  process.exitCode = 1;
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (worker) {
    if (worker.connected) worker.send({type: 'AVS_WORKER_STOP'});
    for (let wait = 0; wait < 100 && worker.exitCode === null; wait++) await pause(100);
    if (worker.exitCode === null) worker.kill();
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString(); await save();
  await fs.writeFile(path.join(output, 'worker.log'), workerLog.replaceAll(config.geminiApiKey, '[REDACTED]'));
  process.stdout.write(JSON.stringify({event: 'PHASE4_E2E_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
