import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import mongoose from 'mongoose';
import {chromium, expect} from '@playwright/test';
import {demoRoot, readDemoProfile, assessDemoProfile} from '../ops/demo/profile.mjs';
import {repositoryRoot} from '../ops/production/profile.mjs';

const profile = await readDemoProfile(), status = JSON.parse(await fs.readFile(path.join(demoRoot, 'status.json'), 'utf8'));
if (!status.online || !assessDemoProfile(profile, status.origin).passed) throw new Error('RUNNING_TEMPORARY_DEMO_REQUIRED');
if (!['COOKIE_FORM', 'APP_LOGIN_ONLY'].includes(status.accessMode)) throw new Error('DEMO_ACCESS_MODE_INVALID');
const requireAccess = status.accessMode === 'COOKIE_FORM';
const origin = status.origin, runId = `public-${Date.now()}-${randomBytes(4).toString('hex')}`;
const output = path.join(repositoryRoot, 'artifacts/demo', runId);
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), origin, temporary: true, accessMode: status.accessMode, automaticHttpCredentials: false, nativeAuthenticationChallenges: 0, publicTlsVerified: true, realEmailSent: false, realGeminiRequest: false, realRender: false, checks: [], browserErrors: [], passed: false};
const save = () => fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const email = `${runId}@example.test`, password = randomBytes(24).toString('base64url') + '42!';
let browser, context, page, connection, userId;
async function data(response, expected = 200) {const body = await response.json(); assert.equal(response.status(), expected, body.error?.code || 'Unexpected HTTP status'); return body.data;}
async function mutate(route, body) {const proof = await data(await context.request.get(origin + '/api/v1/auth/csrf')); return context.request.post(origin + '/api/v1' + route, {headers: {Origin: origin, 'X-CSRF-Token': proof.csrfToken}, data: body});}
async function check(name, operation) {await operation(); report.checks.push({name, passed: true}); await save(); console.log(JSON.stringify({event: 'DEMO_CHECK_PASSED', name}));}
try {
  await check(requireAccess ? 'Public HTTPS remains gated without triggering native password prompts' : 'Public HTTPS opens normal app pages while protected APIs still require login', async () => {
    const routes = requireAccess
      ? [['/login', 403], ['/api/v1/health', 403], ['/api/v1/ready', 403], ['/var/demo/profile.env', 403]]
      : [['/login', 200], ['/signup', 200], ['/api/v1/auth/me', 401], ['/api/v1/projects', 401], ['/var/demo/profile.env', 404]];
    for (const [route, expected] of routes) {const response = await fetch(origin + route, {signal: AbortSignal.timeout(15000), redirect: 'manual'}); assert.equal(response.status, expected); assert.equal(response.headers.get('www-authenticate'), null); if (!requireAccess && ['/login', '/signup'].includes(route)) assert.ok(!(await response.text()).includes('Open the studio demo')); else await response.body?.cancel();}
  });
  browser = await chromium.launch({executablePath: profile.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message.slice(0, 300)));
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', event => {void cdp.send('Fetch.continueRequest', {requestId: event.requestId}).catch(() => {});});
  cdp.on('Fetch.authRequired', event => {report.nativeAuthenticationChallenges++; void cdp.send('Fetch.continueWithAuth', {requestId: event.requestId, authChallengeResponse: {response: 'CancelAuth'}}).catch(() => {});});
  await cdp.send('Fetch.enable', {handleAuthRequests: true, patterns: [{urlPattern: '*'}]});
  await check(requireAccess ? 'Normal browser access form persists a separate secure session without HTTP credentials' : 'Fresh browser opens signup directly with no separate demo access prompt', async () => {
    await page.goto(origin + '/signup');
    if (requireAccess) {
      await expect(page.getByLabel('Demo username', {exact: true})).toBeVisible();
      await page.getByLabel('Demo username', {exact: true}).fill(profile.DEMO_GATE_USER); await page.getByLabel('Demo password', {exact: true}).fill(profile.DEMO_GATE_PASSWORD); await page.getByRole('button', {name: 'Open demo', exact: true}).click(); await expect(page).toHaveURL(origin + '/signup');
      const gate = (await context.cookies()).find(cookie => cookie.name === '__Host-avs_demo'); assert.ok(gate?.secure && gate.httpOnly && gate.path === '/' && gate.sameSite === 'Lax');
    } else {
      await expect(page).toHaveURL(origin + '/signup');
      await expect(page.getByLabel('Demo username', {exact: true})).toHaveCount(0);
      await expect(page.getByRole('button', {name: 'Open demo', exact: true})).toHaveCount(0);
      assert.ok(!(await context.cookies()).some(cookie => cookie.name === '__Host-avs_demo'));
      assert.equal((await context.request.get(origin + '/api/v1/auth/me')).status(), 401);
    }
    await page.reload(); await expect(page).toHaveURL(origin + '/signup'); await expect(page.getByRole('button', {name: 'Create account', exact: true})).toBeVisible(); assert.equal(report.nativeAuthenticationChallenges, 0);
  });
  await check('Real signup works through the public tunnel with secure session cookies', async () => {
    const response = await page.goto(origin + '/signup'); assert.equal(response.status(), 200); assert.ok(response.headers()['strict-transport-security']);
    await page.getByLabel('Your name', {exact: true}).fill('Temporary Demo Check'); await page.getByLabel('Email address', {exact: true}).fill(email); await page.getByLabel('Password', {exact: true}).fill(password);
    await page.getByRole('button', {name: 'Create account', exact: true}).click(); await expect(page).toHaveURL(origin + '/app');
    userId = (await data(await context.request.get(origin + '/api/v1/auth/me'))).user.id;
    const cookies = await context.cookies(); assert.ok(cookies.length >= (requireAccess ? 4 : 3)); assert.ok(cookies.every(cookie => cookie.secure)); const authCookies = cookies.filter(cookie => /access|refresh/u.test(cookie.name)); assert.ok(authCookies.length >= 2); assert.ok(authCookies.every(cookie => cookie.httpOnly));
  });
  await check('Saved projects persist and the dedicated renderer reports available', async () => {
    const project = await data(await mutate('/projects', {title: 'Temporary public demo check', prompt: 'Explain the water cycle in a short educational video.', settings: {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS'}}), 201);
    await page.goto(origin + '/app/projects/' + project.id + '/review'); await expect(page.getByRole('heading', {name: project.title, exact: true})).toBeVisible(); await page.reload(); await expect(page.getByRole('heading', {name: project.title, exact: true})).toBeVisible();
    await expect.poll(async () => Boolean((await data(await context.request.get(origin + '/api/v1/capabilities'))).worker.available), {timeout: 35000}).toBe(true);
    assert.equal((await data(await context.request.get(origin + '/api/v1/ready'))).status, 'ready');
  });
  await check('Disabled email is clear and private files/CSRF remain protected', async () => {
    await page.goto(origin + '/app/settings'); await expect(page.getByText('Email delivery is unavailable.', {exact: false})).toBeVisible(); await expect(page.getByRole('button', {name: 'Send verification email', exact: true})).toBeDisabled();
    for (const route of ['/var/demo/profile.env', '/var/demo/access.txt', '/.env', '/.env.production.local']) assert.equal((await context.request.get(origin + route)).status(), 404);
    assert.equal((await context.request.post(origin + '/api/v1/projects', {data: {title: 'no-CSRF'}})).status(), 403);
    const proof = await data(await context.request.get(origin + '/api/v1/auth/csrf'));
    assert.equal((await context.request.post(origin + '/api/v1/auth/logout', {headers: {Origin: 'https://foreign.example', 'X-CSRF-Token': proof.csrfToken}, data: {}})).status(), 403);
  });
  await check('Logout and login work through the public HTTPS gateway', async () => {
    await page.getByRole('button', {name: 'Sign out', exact: true}).click(); await expect(page).toHaveURL(origin + '/login');
    assert.equal((await context.request.get(origin + '/api/v1/auth/me')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/v1/projects')).status(), 401);
    await page.getByLabel('Email address', {exact: true}).fill(email); await page.getByLabel('Password', {exact: true}).fill(password); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page).toHaveURL(origin + '/app');
    await page.screenshot({path: path.join(output, 'public-dashboard.png'), fullPage: true});
    assert.equal((await mutate('/auth/logout', {})).status(), 204);
    assert.equal((await context.request.get(origin + '/api/v1/auth/me')).status(), 401);
  });
  assert.equal(report.browserErrors.length, 0); assert.equal(report.nativeAuthenticationChallenges, 0); report.passed = true;
} catch (error) {
  let message = String(error.message); for (const value of [password, profile.DEMO_GATE_PASSWORD, profile.GEMINI_API_KEY, profile.JWT_SECRET, profile.CSRF_SECRET, profile.MAIL_ENCRYPTION_SECRET]) if (value) message = message.replaceAll(value, '[REDACTED]');
  report.failure = {name: error.name, message: message.slice(0, 1400)}; process.exitCode = 1; console.error(JSON.stringify({event: 'DEMO_CHECK_FAILED', ...report.failure}));
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    connection = await mongoose.createConnection(profile.MONGODB_URI, {serverSelectionTimeoutMS: 5000}).asPromise();
    const user = await connection.db.collection('users').findOne({emailNormalized: email});
    if (user && (!userId || String(user._id) === userId)) {
      await connection.db.collection('projects').deleteMany({ownerId: user._id}); await connection.db.collection('sessions').deleteMany({userId: user._id}); await connection.db.collection('users').deleteOne({_id: user._id, emailNormalized: email});
    }
    report.testAccountCleaned = true;
  } catch {report.testAccountCleaned = false; report.passed = false; process.exitCode = 1;}
  if (connection) await connection.close().catch(() => {});
  report.completedAt = new Date().toISOString(); await save(); console.log(JSON.stringify({event: 'DEMO_CHECK_COMPLETED', passed: report.passed, checks: report.checks.length, report: path.join(output, 'report.json')}));
}
