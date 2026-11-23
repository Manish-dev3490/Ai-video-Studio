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
import {startMailDispatcher} from '../apps/api/src/mail.js';

// Real application/browser/database/local-mail integration. No cloud provider,
// engine fixture, TTS, rendering or existing development-account data is used.
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = 'e2e-' + Date.now();
const output = path.join(root, 'artifacts/phase5', runId);
const privateRoot = path.join(root, 'var/phase5-tests', runId);
const mailbox = path.join(privateRoot, 'mail');
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), mode: 'REAL_BROWSER_MONGODB_PRIVATE_LOCAL_MAIL', realExternalEmail: false, realGemini: false, realRender: false, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const freePort = () => new Promise(resolve => {const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});});
const databasePort = await freePort(), apiPort = await freePort();
const origin = `http://127.0.0.1:${apiPort}`;
const config = {...loadConfig({NODE_ENV: 'test', APP_ORIGIN: origin, API_PORT: String(apiPort), MONGODB_URI: `mongodb://127.0.0.1:${databasePort}/phase5_e2e?replicaSet=phase5Test`, JWT_SECRET: randomBytes(48).toString('base64url'), CSRF_SECRET: randomBytes(48).toString('base64url'), MAIL_TRANSPORT: 'local', MAIL_PREVIEW_ROOT: mailbox, PRIVATE_STORAGE_ROOT: path.join(privateRoot, 'media'), WORKER_WORK_ROOT: path.join(privateRoot, 'jobs')}), authRateLimit: 100, accountActionRateLimit: 100, accountTokenRateLimit: 100, accountProfileRateLimit: 100, mailPollMs: 100};
const oldPassword = 'An original studio passphrase stays private. 42';
const newPassword = 'A renewed studio passphrase stays private. 84';
const ownerEmail = `phase5-owner-${Date.now()}@example.test`;
const nextEmail = `phase5-new-${Date.now()}@example.test`;
const otherEmail = `phase5-other-${Date.now()}@example.test`;
let mongo, connection, repository, models, server, dispatcher, browser, page;
let ownerContext, ownerId, projectId, verificationLink, resetLink, changeLink;
const secrets = new Set([oldPassword, newPassword]);
const redact = value => {let text = String(value); for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]'); return text.replace(/[a-f0-9]{24}\.[A-Za-z0-9_-]{43}/gu, '[ACTION_LINK_REDACTED]').slice(0, 1500);};
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); process.stdout.write(JSON.stringify({event: 'PHASE5_CHECK_PASSED', name}) + '\n');}
async function data(response, status = 200) {const payload = await response.json(); assert.equal(response.status(), status, 'Unexpected API status' + (payload.error?.code ? ': ' + payload.error.code : '')); return payload.data;}
async function mutate(context, method, route, body = {}) {const proof = await data(await context.get(origin + '/api/v1/auth/csrf')); return context.fetch(origin + '/api/v1' + route, {method, headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken}, data: body});}
async function signup(context, email, displayName = 'Phase Five Owner') {
  const tab = await context.newPage(); attach(tab); await tab.goto(origin + '/signup');
  await tab.getByLabel('Your name', {exact: true}).fill(displayName);
  await tab.getByLabel('Email address', {exact: true}).fill(email);
  await tab.getByLabel('Password', {exact: true}).fill(oldPassword);
  await tab.getByRole('button', {name: 'Create account', exact: true}).click();
  await expect(tab).toHaveURL(/\/app$/u); return tab;
}
async function login(context, email, password, expectedStatus = 200) {
  const tab = await context.newPage(); attach(tab); await tab.goto(origin + '/login');
  await tab.getByLabel('Email address', {exact: true}).fill(email); await tab.getByLabel('Password', {exact: true}).fill(password);
  const response = tab.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/login'));
  await tab.getByRole('button', {name: 'Sign in', exact: true}).click(); assert.equal((await response).status(), expectedStatus);
  if (expectedStatus === 200) await expect(tab).toHaveURL(/\/app$/u); return tab;
}
function attach(tab) {tab.on('pageerror', error => report.browserErrors.push(redact(error.message)));}
async function mail(to, subject) {
  let result;
  await expect.poll(async () => {
    let files; try {files = await fs.readdir(mailbox);} catch {return false;}
    for (const file of files) {
      if (!/^[a-f0-9]{24}\.json$/u.test(file)) continue;
      let parsed; try {parsed = JSON.parse(await fs.readFile(path.join(mailbox, file), 'utf8'));} catch {continue;}
      if (parsed.to === to && parsed.subject.includes(subject)) {result = parsed; return true;}
    }
    return false;
  }, {timeout: 15000}).toBe(true);
  return result;
}
function link(message, pathname) {const value = message.text.split(/\s+/u).find(word => word.startsWith(origin + pathname + '#token=')); assert.ok(value, 'Private local email contains its same-origin action link'); const token = new URLSearchParams(new URL(value).hash.slice(1)).get('token'); secrets.add(token); return value;}
async function scrubbed(tab, pathname, secretLink) {await expect(tab).toHaveURL(origin + pathname); const token = new URLSearchParams(new URL(secretLink).hash.slice(1)).get('token'); const storage = await tab.evaluate(() => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}, resources: performance.getEntriesByType('resource').map(entry => entry.name)})); assert.equal(storage.includes(token), false);}
async function sameDocumentLink(tab, value) {await tab.evaluate(url => {window.location.assign(url);}, value);}

try {
  await fs.access(path.join(root, 'apps/web/dist/index.html'));
  mongo = await startLocalMongo({directory: path.join(privateRoot, 'mongodb'), port: databasePort, replicaSet: 'phase5Test'});
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
  repository = createMongoRepository(connection); await repository.initialize();
  models = createStudioModels(connection); await initializeStudioModels(models);
  const app = createApp({config, repository, studioRouter: buildStudioRouter({connection, config, models}), dashboardRouter: buildDashboardRouter({connection, config}), staticDirectory: path.join(root, 'apps/web/dist')});
  await app.locals.account.initialize(); models = {...models, ...app.locals.account.models};
  dispatcher = startMailDispatcher({models, config});
  server = await new Promise((resolve, reject) => {const instance = app.listen(apiPort, '127.0.0.1', () => resolve(instance)); instance.once('error', reject);});
  browser = await chromium.launch({executablePath: config.browserExecutable, headless: true});
  ownerContext = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});

  await check('Signup queues a private verification email and unverified owner can still save a project', async () => {
    page = await signup(ownerContext, ownerEmail);
    const user = await data(await ownerContext.request.get(origin + '/api/v1/auth/me')); ownerId = user.user.id;
    assert.deepEqual(Object.keys(user.user).sort(), ['displayName', 'email', 'id']);
    const profile = await data(await ownerContext.request.get(origin + '/api/v1/account/profile')); assert.equal(profile.emailVerified, false); assert.equal(profile.emailDelivery.mode, 'LOCAL_PREVIEW');
    verificationLink = link(await mail(ownerEmail, 'Verify your AI Video Studio email'), '/verify-email');
    await page.getByRole('link', {name: 'Create video', exact: true}).click();
    await page.getByLabel('Project title', {exact: true}).fill('Account regression project');
    await page.getByLabel('What would you like to explain?', {exact: true}).fill('Explain the event loop without changing this saved project during account updates.');
    await page.getByRole('button', {name: 'Save project', exact: true}).click();
    await expect(page).toHaveURL(/\/app\/projects\/[a-f0-9]{24}\/review$/u); projectId = page.url().match(/projects\/([a-f0-9]{24})/u)[1];
  });

  await check('Profile name updates persist and propagate to another open dashboard tab', async () => {
    await page.goto(origin + '/app/settings');
    const otherTab = await ownerContext.newPage(); attach(otherTab); await otherTab.goto(origin + '/app/settings');
    await expect(otherTab.getByLabel('Display name', {exact: true})).toHaveValue('Phase Five Owner');
    await page.getByLabel('Display name', {exact: true}).fill('Revised Studio Owner');
    await page.getByRole('button', {name: 'Save profile', exact: true}).click();
    await expect(page.locator('.sidebar-profile strong')).toHaveText('Revised Studio Owner');
    await expect(otherTab.getByLabel('Display name', {exact: true})).toHaveValue('Revised Studio Owner');
    await page.reload(); await expect(page.getByLabel('Display name', {exact: true})).toHaveValue('Revised Studio Owner');
    await page.screenshot({path: path.join(output, 'profile-local-preview.png'), fullPage: true}); await otherTab.close();
  });

  await check('Verification scrubs the fragment, requires explicit confirmation and rejects same-route replay', async () => {
    const requests = []; page.on('request', request => {if (request.method() === 'POST' && request.url().endsWith('/auth/verify-email')) requests.push(request);});
    await page.goto(verificationLink); await scrubbed(page, '/verify-email', verificationLink);
    await expect(page.getByRole('button', {name: 'Verify email', exact: true})).toBeEnabled(); assert.equal(requests.length, 0);
    await page.getByRole('button', {name: 'Verify email', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Email verified.', exact: true})).toBeVisible(); assert.equal(requests.length, 1);
    assert.equal((await data(await ownerContext.request.get(origin + '/api/v1/account/profile'))).emailVerified, true);
    await sameDocumentLink(page, verificationLink); await scrubbed(page, '/verify-email', verificationLink);
    const replay = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/verify-email'));
    await page.getByRole('button', {name: 'Verify email', exact: true}).click(); assert.equal((await replay).status(), 422);
    await expect(page.getByRole('alert')).toContainText('invalid, expired or already used');
  });

  const recoveryContext = await browser.newContext({viewport: {width: 1200, height: 900}});
  let resetPage;
  await check('Forgot-password UI returns the same generic local-delivery result for existing and absent emails', async () => {
    resetPage = await recoveryContext.newPage(); attach(resetPage); await resetPage.goto(origin + '/login');
    await resetPage.getByRole('link', {name: 'Forgot password?', exact: true}).click();
    await resetPage.getByLabel('Email address', {exact: true}).fill(ownerEmail);
    const response = resetPage.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/forgot-password'));
    await resetPage.getByRole('button', {name: 'Send reset link', exact: true}).click(); const existing = await data(await response, 202);
    await expect(resetPage.getByRole('heading', {name: 'Check for reset instructions.', exact: true})).toBeVisible();
    await expect(resetPage.getByText('This studio uses a private local email preview. No message is sent to an inbox.', {exact: true})).toBeVisible();
    const absentPage = await recoveryContext.newPage(); attach(absentPage); await absentPage.goto(origin + '/forgot-password');
    await absentPage.getByLabel('Email address', {exact: true}).fill('absent-' + Date.now() + '@example.test');
    const absentResponse = absentPage.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/forgot-password'));
    await absentPage.getByRole('button', {name: 'Send reset link', exact: true}).click(); assert.deepEqual(await data(await absentResponse, 202), existing); await absentPage.close();
    resetLink = link(await mail(ownerEmail, 'Reset your AI Video Studio password'), '/reset-password');
  });

  const secondDevice = await browser.newContext(); await login(secondDevice, ownerEmail, oldPassword);
  await check('Password reset validates fields, consumes once and revokes every previous owner session', async () => {
    await resetPage.goto(resetLink); await scrubbed(resetPage, '/reset-password', resetLink);
    await resetPage.getByLabel('New password', {exact: true}).fill('short'); await resetPage.getByLabel('Confirm new password', {exact: true}).fill('different');
    await resetPage.getByRole('button', {name: 'Reset password', exact: true}).click(); await expect(resetPage.getByText('The passwords do not match.', {exact: true})).toBeVisible();
    await resetPage.getByLabel('New password', {exact: true}).fill(newPassword); await resetPage.getByLabel('Confirm new password', {exact: true}).fill(newPassword);
    await resetPage.getByRole('button', {name: 'Reset password', exact: true}).click();
    await expect(resetPage.getByRole('heading', {name: 'Your password has been reset.', exact: true})).toBeVisible();
    assert.equal((await ownerContext.request.get(origin + '/api/v1/auth/me')).status(), 401); assert.equal((await secondDevice.request.get(origin + '/api/v1/auth/me')).status(), 401);
    assert.equal((await recoveryContext.request.get(origin + '/api/v1/auth/me')).status(), 401);
    await sameDocumentLink(resetPage, resetLink); await scrubbed(resetPage, '/reset-password', resetLink);
    await resetPage.getByLabel('New password', {exact: true}).fill(newPassword); await resetPage.getByLabel('Confirm new password', {exact: true}).fill(newPassword);
    const replay = resetPage.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/reset-password'));
    await resetPage.getByRole('button', {name: 'Reset password', exact: true}).click(); assert.equal((await replay).status(), 422);
    await page.goto(origin + '/app/settings'); await expect(page).toHaveURL(/\/login$/u);
    await resetPage.screenshot({path: path.join(output, 'used-reset-link.png'), fullPage: true});
  });

  const currentOwner = await browser.newContext({viewport: {width: 1440, height: 1000}});
  let currentPage;
  await check('Only the new password signs in and the saved owner project survives recovery', async () => {
    const failed = await login(currentOwner, ownerEmail, oldPassword, 401); await failed.close();
    currentPage = await login(currentOwner, ownerEmail, newPassword);
    const user = await data(await currentOwner.request.get(origin + '/api/v1/auth/me')); assert.equal(user.user.id, ownerId); assert.equal(user.user.displayName, 'Revised Studio Owner');
    const project = await data(await currentOwner.request.get(origin + '/api/v1/projects/' + projectId)); assert.equal(project.id, projectId);
    const notice = await mail(ownerEmail, 'password was reset'); assert.equal(notice.text.includes('#token='), false);
  });

  await check('Email change requires the current password and keeps the existing address until proof', async () => {
    await currentPage.goto(origin + '/app/settings'); await currentPage.getByText('Change sign-in email', {exact: true}).click();
    await currentPage.getByLabel('New email address', {exact: true}).fill(nextEmail); await currentPage.getByLabel('Current password', {exact: true}).fill('incorrect-current-password');
    const denied = currentPage.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/account/email-change'));
    await currentPage.getByRole('button', {name: 'Send email confirmation', exact: true}).click(); assert.equal((await denied).status(), 403);
    await currentPage.getByLabel('Current password', {exact: true}).fill(newPassword);
    await currentPage.getByRole('button', {name: 'Send email confirmation', exact: true}).click();
    await expect(currentPage.getByText('Confirmation pending', {exact: true})).toBeVisible();
    const profile = await data(await currentOwner.request.get(origin + '/api/v1/account/profile')); assert.equal(profile.user.email, ownerEmail); assert.equal(profile.pendingEmailChange.email, nextEmail);
    changeLink = link(await mail(nextEmail, 'Confirm your AI Video Studio email change'), '/confirm-email-change');
    await currentPage.screenshot({path: path.join(output, 'pending-email-change.png'), fullPage: true});
  });

  const unrelated = await browser.newContext(); const unrelatedPage = await signup(unrelated, otherEmail, 'Unrelated Owner');
  const unrelatedDevice = await browser.newContext(); await login(unrelatedDevice, otherEmail, oldPassword);
  await check('Confirmation changes the intended account without logging an unrelated browser into it', async () => {
    await unrelatedPage.goto(changeLink); await scrubbed(unrelatedPage, '/confirm-email-change', changeLink);
    await unrelatedPage.getByRole('button', {name: 'Confirm email change', exact: true}).click();
    await expect(unrelatedPage.getByRole('heading', {name: 'Your sign-in email has changed.', exact: true})).toBeVisible();
    assert.equal((await currentOwner.request.get(origin + '/api/v1/auth/me')).status(), 401); assert.equal((await unrelated.request.get(origin + '/api/v1/auth/me')).status(), 401);
    assert.equal((await data(await unrelatedDevice.request.get(origin + '/api/v1/auth/me'))).user.email, otherEmail);
    const failed = await login(currentOwner, ownerEmail, newPassword, 401); await failed.close();
    const signedIn = await login(currentOwner, nextEmail, newPassword);
    const profile = await data(await currentOwner.request.get(origin + '/api/v1/account/profile')); assert.equal(profile.user.id, ownerId); assert.equal(profile.emailVerified, true); assert.equal(profile.pendingEmailChange, null);
    assert.equal((await data(await currentOwner.request.get(origin + '/api/v1/projects/' + projectId))).id, projectId);
    assert.equal((await unrelatedDevice.request.get(origin + '/api/v1/projects/' + projectId)).status(), 404);
    const notice = await mail(ownerEmail, 'email was changed'); assert.equal(notice.text.includes('#token='), false);
    await signedIn.close();
  });

  await check('Cancelling a pending email change invalidates its link and keeps the original identity', async () => {
    const tab = await unrelatedDevice.newPage(); attach(tab); await tab.goto(origin + '/app/settings');
    await tab.getByText('Change sign-in email', {exact: true}).click(); await tab.getByLabel('New email address', {exact: true}).fill('cancel-' + Date.now() + '@example.test');
    const target = await tab.getByLabel('New email address', {exact: true}).inputValue(); await tab.getByLabel('Current password', {exact: true}).fill(oldPassword);
    await tab.getByRole('button', {name: 'Send email confirmation', exact: true}).click(); await expect(tab.getByText('Confirmation pending', {exact: true})).toBeVisible();
    const cancelledLink = link(await mail(target, 'Confirm your AI Video Studio email change'), '/confirm-email-change');
    await tab.getByRole('button', {name: 'Cancel pending email change', exact: true}).click(); await expect(tab.getByText('Confirmation pending', {exact: true})).toHaveCount(0);
    const anonymous = await browser.newContext(); const confirm = await anonymous.newPage(); attach(confirm); await confirm.goto(cancelledLink); await scrubbed(confirm, '/confirm-email-change', cancelledLink);
    const response = confirm.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/auth/confirm-email-change'));
    await confirm.getByRole('button', {name: 'Confirm email change', exact: true}).click(); assert.equal((await response).status(), 422);
    assert.equal((await data(await unrelatedDevice.request.get(origin + '/api/v1/auth/me'))).user.email, otherEmail); await anonymous.close(); await tab.close();
  });

  await check('Private previews stay off HTTP and sensitive metadata is not returned by auth/profile', async () => {
    const files = (await fs.readdir(mailbox)).filter(file => file.endsWith('.json')); assert.ok(files.length >= 5);
    assert.equal((await currentOwner.request.get(origin + '/var/phase5-tests/' + runId + '/mail/' + files[0])).status(), 404);
    const publicProfile = await data(await currentOwner.request.get(origin + '/api/v1/account/profile'));
    for (const secret of secrets) assert.equal(JSON.stringify(publicProfile).includes(secret), false);
    assert.equal(JSON.stringify(publicProfile).includes('tokenHash'), false); assert.equal(JSON.stringify(publicProfile).includes('authVersion'), false);
    report.privateMailCount = files.length;
  });
  assert.equal(report.browserErrors.length, 0); report.passed = true;
} catch (error) {
  report.failure = {name: error.name, message: redact(error.message)}; process.exitCode = 1;
  process.stderr.write(JSON.stringify({event: 'PHASE5_E2E_FAILED', ...report.failure}) + '\n');
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise(resolve => server.close(resolve));
  if (dispatcher) await dispatcher.stop();
  if (connection) await connection.close().catch(() => {});
  if (mongo) await mongo.stop().catch(() => {});
  report.completedAt = new Date().toISOString(); await save();
  process.stdout.write(JSON.stringify({event: 'PHASE5_E2E_COMPLETED', passed: report.passed, checks: report.checks.length, reportPath: path.join(output, 'report.json')}) + '\n');
}
