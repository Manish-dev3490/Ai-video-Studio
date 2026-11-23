import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium, expect} from '@playwright/test';
import {demoRoot, readDemoProfile, assessDemoProfile} from '../ops/demo/profile.mjs';
import {repositoryRoot} from '../ops/production/profile.mjs';

// Explicit opt-in: this uses the configured Gemini allowance. It never submits
// a render or changes another account's project.
if (process.argv.length !== 3 || process.argv[2] !== '--generate') throw new Error('Use --generate explicitly to run one real planning request for the private diagnostic project.');
const profile = await readDemoProfile(), status = JSON.parse(await fs.readFile(path.join(demoRoot, 'status.json'), 'utf8'));
const qa = JSON.parse(await fs.readFile(path.join(demoRoot, 'ai-check-state.json'), 'utf8'));
if (!status.online || !assessDemoProfile(profile, status.origin).passed || !/^[a-f0-9]{24}$/u.test(qa.projectId) || !qa.email.startsWith('script-check-') || !qa.email.endsWith('@example.test')) throw new Error('RUNNING_DEMO_AND_PRIVATE_DIAGNOSTIC_ACCOUNT_REQUIRED');
const origin = status.origin, output = path.join(repositoryRoot, 'artifacts/script-generation-fix');
await fs.mkdir(output, {recursive: true});
const report = {startedAt: new Date().toISOString(), origin, targetDurationSec: 90, realGemini: true, realRender: false, checks: [], nativeAuthenticationChallenges: 0, browserErrors: [], passed: false};
let browser, page;
const save = () => fs.writeFile(path.join(output, 'live-script-report.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, action) {await action(); report.checks.push({name, passed: true}); await save(); console.log(JSON.stringify({event: 'SCRIPT_CHECK_PASSED', name}));}
try {
  browser = await chromium.launch({executablePath: profile.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1100}});
  page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.name));
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', event => {void cdp.send('Fetch.continueRequest', {requestId: event.requestId}).catch(() => {});});
  cdp.on('Fetch.authRequired', event => {report.nativeAuthenticationChallenges++; void cdp.send('Fetch.continueWithAuth', {requestId: event.requestId, authChallengeResponse: {response: 'CancelAuth'}}).catch(() => {});});
  await cdp.send('Fetch.enable', {handleAuthRequests: true, patterns: [{urlPattern: '*'}]});
  await check('Normal demo access and isolated diagnostic account login', async () => {
    await page.goto(origin + '/login'); await page.getByLabel('Demo username', {exact: true}).fill(profile.DEMO_GATE_USER); await page.getByLabel('Demo password', {exact: true}).fill(profile.DEMO_GATE_PASSWORD); await page.getByRole('button', {name: 'Open demo', exact: true}).click();
    await page.getByLabel('Email address', {exact: true}).fill(qa.email); await page.getByLabel('Password', {exact: true}).fill(qa.password); await page.getByRole('button', {name: 'Sign in', exact: true}).click(); await expect(page).toHaveURL(origin + '/app');
    const me = (await (await context.request.get(origin + '/api/v1/auth/me')).json()).data.user;
    assert.equal(me.id, qa.userId); assert.ok(me.email === qa.email, 'Only the private diagnostic account is used');
  });
  await check('Generate a fresh 90-second script from the public dashboard', async () => {
    await page.goto(origin + `/app/projects/${qa.projectId}/assistant`);
    // This account has no chat history: the composer initially seeds the saved
    // idea. Clear that unsent duplicate; the saved project prompt remains input.
    const savedProject = (await (await context.request.get(origin + `/api/v1/projects/${qa.projectId}`)).json()).data;
    const composer = page.getByLabel('Message the AI assistant', {exact: true});
    await expect(composer).toHaveValue(savedProject.prompt, {timeout: 10000});
    await composer.fill(''); await expect(composer).toHaveValue('');
    const button = page.getByRole('button', {name: 'Generate script', exact: true}); await expect(button).toBeEnabled();
    const started = Date.now(), responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${qa.projectId}/storyboards/generate`), {timeout: 155000});
    await button.click(); const response = await responsePromise; let body; try {body = await response.json();} catch {}
    report.planning = {httpStatus: response.status(),seconds: (Date.now() - started) / 1000,contentType: response.headers()['content-type'],code: body?.error?.code || null,responseJsonKeys: body && typeof body === 'object' ? Object.keys(body) : [],edgeErrorCodes: Array.isArray(body?.errors) ? body.errors.map(error => error.code).filter(code => typeof code === 'number' || typeof code === 'string') : [],requestAcceptsJson: response.request().headers().accept?.includes('application/json') || false};
    await fs.writeFile(path.join(demoRoot, 'last-script-http-response.json'), JSON.stringify({status: response.status(), body}, null, 2) + '\n', {mode: 0o600}); await save();
    assert.equal(response.status(), 200, body?.error?.code || 'Structured script response required');
    const draft = body?.data; assert.ok(draft?.id && Array.isArray(draft.scenes));
    report.storyboardId = draft.id; report.sceneCount = draft.scenes.length; report.narrationWords = draft.scenes.map(scene => scene.narration).join(' ').trim().split(/\s+/u).length;
    assert.ok(report.narrationWords >= 199 && report.narrationWords <= 221, '90-second narration respects the existing measured-length guidance');
    await expect(page).toHaveURL(origin + `/app/projects/${qa.projectId}/review`, {timeout: 10000});
    await fs.writeFile(path.join(demoRoot, 'checked-storyboard.json'), JSON.stringify(draft, null, 2) + '\n', {mode: 0o600});
  });
  await check('Fresh draft persists across reload and is ready for explicit approval', async () => {
    await page.reload(); const approve = page.getByRole('button', {name: 'Approve script', exact: true}); await expect(approve).toBeEnabled();
    const current = (await (await context.request.get(origin + `/api/v1/projects/${qa.projectId}/storyboards/current`)).json()).data;
    assert.equal(current.id, report.storyboardId); assert.equal(current.status, 'DRAFT');
    await approve.click(); await expect(page.getByRole('button', {name: 'Start rendering', exact: true})).toBeEnabled({timeout: 15000});
    const approved = (await (await context.request.get(origin + `/api/v1/projects/${qa.projectId}/storyboards/current`)).json()).data;
    assert.equal(approved.id, report.storyboardId); assert.equal(approved.status, 'APPROVED');
    await page.screenshot({path: path.join(output, 'live-approved-script.png'), fullPage: true});
  });
  assert.equal(report.nativeAuthenticationChallenges, 0); assert.equal(report.browserErrors.length, 0); report.passed = true;
} catch (error) {
  let message = String(error.message); for (const value of [qa.password, profile.DEMO_GATE_PASSWORD, profile.GEMINI_API_KEY, profile.JWT_SECRET, profile.CSRF_SECRET, profile.MAIL_ENCRYPTION_SECRET]) if (value) message = message.replaceAll(value, '[REDACTED]');
  report.failure = {name: error.name, message: message.slice(0, 1400)}; process.exitCode = 1;
  console.error(JSON.stringify({event: 'SCRIPT_CHECK_FAILED', ...report.failure}));
  if (page) await page.screenshot({path: path.join(output, 'live-failure.png'), fullPage: true}).catch(() => {});
} finally {
  if (browser) await browser.close().catch(() => {}); report.completedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({event: 'SCRIPT_CHECK_COMPLETE', passed: report.passed, checks: report.checks.length, report: path.join(output, 'live-script-report.json')}));
}
