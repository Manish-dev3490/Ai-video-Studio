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
import {initializeLocalProfile, readProfile} from '../ops/production/profile.mjs';
import {checkProductionProfile} from './production-check.mjs';
import {ensureLocalCertificate} from './local-production-certificate.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `local-https-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(root, 'artifacts/phase9', runId), privateRoot = path.join(root, 'var/phase9-tests', runId);
await fs.mkdir(output, {recursive: true}); await fs.mkdir(privateRoot, {recursive: true});
const profileFile = path.join(privateRoot, 'profile.env');
const report = {startedAt: new Date().toISOString(), mode: 'REAL_LOCAL_PRODUCTION_HTTPS_SUPERVISOR', productionNodeEnvironment: true, selfSignedCertificateOnly: true, windowsTrustStoreChanged: false, publicDeployment: false, realEmailSent: false, realGemini: false, realRender: false, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => {const value = net.createServer(); value.listen(0, '127.0.0.1', () => {const number = value.address().port; value.close(() => resolve(number));});});
const dbPort = await port(), apiPort = await port(), tlsPort = await port();
const origin = `https://localhost:${tlsPort}`;
const password = 'A local production profile stays isolated. 42';
const canary = 'PHASE9_PRIVATE_CANARY_' + randomBytes(12).toString('hex');
let mongo, connection, supervisor, browser, context, page, capturedLogs = '';
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE9_HTTPS_CHECK_PASSED', name}) + '\n');}
async function data(response, status = 200) {const body = await response.json(); assert.equal(response.status(), status, body.error?.code || 'Unexpected status'); return body.data;}
async function mutate(route, body) {const proof = await data(await context.request.get(origin + '/api/v1/auth/csrf')); return context.request.post(origin + '/api/v1' + route, {headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken}, data: body});}
async function stopSupervisor() {
  if (!supervisor || supervisor.exitCode !== null) return;
  if (supervisor.connected) supervisor.send({type: 'AVS_PRODUCTION_STOP'});
  for (let index = 0; index < 150 && supervisor.exitCode === null; index++) await pause(100);
  assert.notEqual(supervisor.exitCode, null, 'The owned production supervisor exits gracefully');
}
try {
  const existingEnv = await fs.readFile(path.join(root, '.env'));
  await initializeLocalProfile({file: profileFile, ensureCertificate: options => ensureLocalCertificate({...options, directory: path.join(privateRoot, 'tls')})});
  const before = await fs.readFile(profileFile); await initializeLocalProfile({file: profileFile}); assert.ok((await fs.readFile(profileFile)).equals(before), 'Existing private profile is preserved');
  const environment = await readProfile(profileFile);
  Object.assign(environment, {APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${dbPort}/phase9_local_profile?replicaSet=phase9ProfileTest`, AUTO_START_LOCAL_MONGO: 'false', PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs'), MAIL_PREVIEW_ROOT: path.join(privateRoot, 'disabled-mail')});
  await fs.writeFile(profileFile, Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', {mode: 0o600});
  await check('Profile initialization creates independent secrets and never overwrites development configuration', async () => {
    assert.ok((await fs.readFile(path.join(root, '.env'))).equals(existingEnv), 'Development environment is preserved');
    assert.equal(new Set(['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(key => environment[key])).size, 3);
    const configOnly = await checkProductionProfile({file: profileFile, native: true}); assert.equal(configOnly.passed, true); assert.equal(configOnly.realEmailConfigured, false);
    const publicCheck = await checkProductionProfile({file: profileFile, publicLaunch: true}); assert.equal(publicCheck.passed, false); assert.ok(publicCheck.configuration.issues.includes('LOCAL_PROFILE_IS_NOT_A_PUBLIC_DEPLOYMENT'));
  });
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: dbPort, replicaSet: 'phase9ProfileTest'});
  connection = await mongoose.createConnection(environment.MONGODB_URI, {serverSelectionTimeoutMS: 5000}).asPromise();
  const databaseCheck = await checkProductionProfile({file: profileFile, database: true}); assert.equal(databaseCheck.passed, true);
  supervisor = fork(path.join(root, 'scripts/start-production.mjs'), ['--env-file', profileFile], {cwd: root, execArgv: [], env: {...process.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '', RESEND_API_KEY: ''}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const record = chunk => {capturedLogs = (capturedLogs + chunk.toString()).slice(-512000);}; supervisor.stdout.on('data', record); supervisor.stderr.on('data', record);
  await expect.poll(() => capturedLogs.includes('LOCAL_PRODUCTION_ONLINE'), {timeout: 45000}).toBe(true);
  browser = await chromium.launch({executablePath: environment.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  // This exception is confined to the self-signed localhost QA context. The
  // application/gateway never disable TLS verification for public connections.
  context = await browser.newContext({ignoreHTTPSErrors: true, viewport: {width: 1440, height: 1000}});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 500)));
  await check('Real HTTPS supervisor serves the production build and minimal database readiness', async () => {
    assert.equal((await data(await context.request.get(origin + '/api/v1/ready'))).status, 'ready');
    const plain = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/csrf`); assert.equal(plain.status, 426);
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`)).status, 200);
    const pageResponse = await page.goto(origin + '/signup'); assert.equal(pageResponse.status(), 200); assert.ok(pageResponse.headers()['strict-transport-security']);
    assert.ok(pageResponse.headers()['content-security-policy'].includes("default-src 'self'"));
    await expect.poll(async () => Boolean((await connection.db.collection('queueState').findOne({_id: 'generation-capacity'}))?.workerId), {timeout: 30000}).toBe(true);
  });
  await check('Signup, secure cookies and owner project persistence work through the real HTTPS gateway', async () => {
    await page.getByLabel('Your name', {exact: true}).fill('Local Production Review');
    await page.getByLabel('Email address', {exact: true}).fill(`phase9-${Date.now()}@example.test`);
    await page.getByLabel('Password', {exact: true}).fill(password);
    await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(origin + '/app');
    const cookies = await context.cookies();
    assert.ok(cookies.length >= 3); assert.ok(cookies.every(cookie => cookie.secure));
    assert.ok(cookies.filter(cookie => /access|refresh/u.test(cookie.name)).every(cookie => cookie.httpOnly));
    const user = (await data(await context.request.get(origin + '/api/v1/auth/me'))).user; assert.deepEqual(Object.keys(user).sort(), ['displayName', 'email', 'id']);
    const created = await data(await mutate('/projects', {title: 'A private production-profile project', prompt: 'Explain the water cycle for a local production-profile check.', settings: {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'}}), 201);
    report.testProjectId = created.id;
    await page.goto(origin + '/app/projects/' + created.id + '/review'); await expect(page.getByRole('heading', {name: created.title, exact: true})).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', {name: created.title, exact: true})).toBeVisible();
    assert.equal(await connection.db.collection('projects').countDocuments(), 1);
    assert.equal(await connection.db.collection('generationJobs').countDocuments(), 0);
    assert.equal(await connection.db.collection('mailOutbox').countDocuments(), 0);
    await page.screenshot({path: path.join(output, 'https-protected-dashboard.png'), fullPage: true});
  });
  await check('Gateway rejects foreign Host and strips forwarding spoofing while preserving CSRF enforcement', async () => {
    assert.equal((await context.request.get(origin + '/api/v1/health', {headers: {Host: 'foreign.example'}})).status(), 421);
    const response = await context.request.get(origin + '/api/v1/auth/csrf', {headers: {'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '8.8.8.8', Forwarded: 'proto=http;host=foreign.example'}}); assert.equal(response.status(), 200);
    assert.equal((await context.request.post(origin + '/api/v1/projects', {data: {title: canary}})).status(), 403);
    const proof = await data(await context.request.get(origin + '/api/v1/auth/csrf'));
    assert.equal((await context.request.post(origin + '/api/v1/auth/logout', {headers: {Origin: 'https://foreign.example', 'X-CSRF-Token': proof.csrfToken}, data: {}})).status(), 403);
    await context.request.get(origin + `/api/v1/projects/${report.testProjectId}?private_token=${canary}`);
    await context.request.post(origin + '/api/v1/reports', {data: {description: canary}});
    await data(await mutate('/reports', {projectId: report.testProjectId, reasonCode: 'PRIVACY', description: canary}), 201);
    assert.equal(await connection.db.collection('contentReports').countDocuments(), 1, 'Authenticated report transaction commits through HTTPS');
    assert.equal(capturedLogs.includes(canary), false); assert.equal(capturedLogs.includes(password), false);
    for (const key of ['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET']) assert.equal(capturedLogs.includes(environment[key]), false);
    const entries = capturedLogs.split('\n').flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}}).filter(value => value.event === 'HTTP_REQUEST');
    assert.ok(entries.length > 5); assert.ok(entries.every(value => Object.keys(value).sort().join(',') === 'durationMs,event,method,requestId,route,status'));
    assert.ok(entries.every(value => !value.route.includes(report.testProjectId) && !value.route.includes('?')));
    report.httpLogEntries = entries.length;
  });
  await check('Profile stops owned services gracefully and data remains isolated from development', async () => {
    await browser.close(); browser = null; await stopSupervisor();
    const queue = await connection.db.collection('queueState').findOne({_id: 'generation-capacity'}); assert.equal(queue.workerId, null);
    assert.equal(await connection.db.collection('users').countDocuments(), 1);
    assert.equal(await connection.db.collection('projects').countDocuments(), 1);
    assert.equal(await connection.db.collection('generationJobs').countDocuments(), 0);
    assert.ok((await fs.readFile(path.join(root, '.env'))).equals(existingEnv), 'Development environment is preserved');
    await assert.rejects(fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, {signal: AbortSignal.timeout(1500)}));
    report.developmentEnvironmentSha256 = createHash('sha256').update(existingEnv).digest('hex');
  });
  assert.equal(report.browserErrors.length, 0); report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: String(error.message).replaceAll(password, '[REDACTED]').replaceAll(canary, '[CANARY]').slice(0, 1600)};
  process.exitCode = 1; process.stderr.write(JSON.stringify({event: 'PHASE9_HTTPS_FAILED', ...report.failure}) + '\n');
  if (page && browser) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopSupervisor().catch(() => {report.shutdownUnconfirmed = true;});
  if (connection) await connection.close().catch(() => {}); if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString(); await save();
  // Log metadata has been explicitly checked; account payloads/keys are never saved.
  await fs.writeFile(path.join(output, 'supervisor.log'), capturedLogs);
  process.stdout.write(JSON.stringify({event: 'PHASE9_HTTPS_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
