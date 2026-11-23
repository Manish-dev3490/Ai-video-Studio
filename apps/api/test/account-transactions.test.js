import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import mongoose from 'mongoose';
import {createServer} from 'node:http';
import {performance} from 'node:perf_hooks';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {createMongoRepository} from '../src/repository.js';
import {COOKIE_NAMES, hashPassword, verifyPassword} from '../src/security.js';
import {createAccountSubsystem, createAccountServices} from '../src/account/index.js';
import {encryptMail, decryptMail} from '../src/mail.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = process.env.MONGOD_BINARY || 'C:/Program Files/MongoDB/Server/7.0/bin/mongod.exe';
const skip = !existsSync(binary) ? 'Installed MongoDB is required for real account transaction tests.' : false;
const firstPassword = 'The original private account password. 42';
const nextPassword = 'A changed private account password. 84';
let mongo, connection, mongoUri;

before(async () => {
  if (skip) return;
  const port = await new Promise((resolve, reject) => {const listener = net.createServer(); listener.once('error', reject); listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});});
  const directory = path.join(root, 'artifacts/phase5', 'account-transactions-' + Date.now());
  await fs.mkdir(directory, {recursive: true});
  mongo = await startLocalMongo({directory, port, replicaSet: 'account_security_test', binary});
  mongoUri = `mongodb://127.0.0.1:${port}/account_security_test?replicaSet=account_security_test`;
  connection = await mongoose.createConnection(mongoUri, {serverSelectionTimeoutMS: 5000}).asPromise();
});
after(async () => {if (connection) await connection.close(); if (mongo) await mongo.stop();});

async function fixture(t, override = {}, {encryptMailImpl = encryptMail} = {}) {
  let time = Date.now();
  const config = {...loadConfig({NODE_ENV: 'test', MONGODB_URI: mongoUri, APP_ORIGIN: 'http://127.0.0.1:5173', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)}), mailMode: 'local', mailFrom: 'AI Video Studio <no-reply@example.test>', authRateLimit: 1000, accountActionRateLimit: 1000, accountTokenRateLimit: 1000, recoveryResponseFloorMs: 10, ...override};
  const repository = createMongoRepository(connection); await repository.initialize();
  const subsystem = createAccountSubsystem({connection, repository, config, now: () => time, encryptMail: encryptMailImpl}); await subsystem.initialize();
  const server = createServer(createApp({config, repository, accountSubsystem: subsystem, now: () => time}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const cookies = new Map();
    async function request(route, {method = 'GET', body, csrf = true, headers = {}} = {}) {
      const response = await fetch(origin + '/api/v1' + route, {method, headers: {...(method === 'GET' ? {} : {'Origin': config.appOrigin, 'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': decodeURIComponent(cookies.get(COOKIE_NAMES.csrf) || '')} : {})}), Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), ...headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
      for (const line of response.headers.getSetCookie()) {const pair = line.split(';')[0], separator = pair.indexOf('='); const key = pair.slice(0, separator), value = pair.slice(separator + 1); if (value) cookies.set(key, value); else cookies.delete(key);}
      const text = await response.text(); return {status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers};
    }
    return {cookies, request, bootstrap: () => request('/auth/csrf')};
  }
  const browser = client(); await browser.bootstrap();
  const email = 'account-' + randomBytes(6).toString('hex') + '@example.test';
  const signup = await browser.request('/auth/signup', {method: 'POST', body: {displayName: 'Account Test', email, password: firstPassword}}); assert.equal(signup.status, 201);
  const userId = signup.body.data.user.id;
  async function latest(purpose, id = userId) {return subsystem.models.MailOutbox.findOne({userId: id, purpose}).sort({createdAt: -1, _id: -1}).lean();}
  async function link(purpose, id = userId) {const row = await latest(purpose, id); assert.ok(row?.payload, 'An encrypted action email was queued'); const message = decryptMail(row.payload, config, row); const url = new URL(message.text.match(/https?:\/\/[^\s]+/u)[0]); return {token: new URLSearchParams(url.hash.slice(1)).get('token'), url, row, message};}
  return {config, repository, subsystem, browser, client, userId, email, latest, link, advance: value => {time += value;}, now: () => time};
}

test('real signup queues encrypted verification; profile/name update preserves the approved public DTO', {skip}, async t => {
  const f = await fixture(t);
  const publicMe = await f.browser.request('/auth/me'); assert.deepEqual(Object.keys(publicMe.body.data.user).sort(), ['displayName', 'email', 'id']);
  const profile = await f.browser.request('/account/profile'); assert.equal(profile.status, 200); assert.equal(profile.body.data.emailVerified, false); assert.equal(profile.body.data.emailDelivery.mode, 'LOCAL_PREVIEW');
  const mail = await f.link('VERIFY_EMAIL'); assert.equal(mail.url.origin, f.config.appOrigin); assert.equal(mail.url.pathname, '/verify-email'); assert.equal(mail.url.search, '');
  const token = await f.subsystem.models.ActionToken.findOne({userId: f.userId, purpose: 'VERIFY_EMAIL'}).lean(); assert.match(token.tokenHash, /^[a-f0-9]{64}$/u); assert.ok(!JSON.stringify(token).includes(mail.token)); assert.ok(!JSON.stringify(mail.row).includes(mail.token));
  const changed = await f.browser.request('/account/profile', {method: 'PATCH', body: {displayName: '  Renamed Creator  '}}); assert.equal(changed.status, 200); assert.equal(changed.body.data.user.displayName, 'Renamed Creator');
  assert.equal((await f.browser.request('/auth/me')).body.data.user.displayName, 'Renamed Creator');
  assert.equal((await f.browser.request('/account/profile', {method: 'PATCH', body: {displayName: 'X', role: 'ADMIN'}})).status, 422);
  const anonymous = f.client(); assert.equal((await anonymous.request('/account/profile')).status, 401);
  assert.equal((await f.browser.request('/account/profile', {method: 'PATCH', body: {displayName: 'Another Name'}, csrf: false})).status, 403);
});

test('verification is explicit, single use and purpose bound; unrelated sessions remain signed in', {skip}, async t => {
  const f = await fixture(t); const mail = await f.link('VERIFY_EMAIL');
  assert.equal((await f.browser.request('/auth/verify-email?token=' + encodeURIComponent(mail.token))).status, 404, 'GET does not consume a link');
  assert.equal((await f.browser.request('/auth/reset-password', {method: 'POST', body: {token: mail.token, password: nextPassword}})).body.error.code, 'INVALID_ACTION_LINK');
  assert.equal((await f.browser.request('/auth/verify-email', {method: 'POST', body: {token: mail.token}})).status, 200);
  assert.equal((await f.browser.request('/auth/verify-email', {method: 'POST', body: {token: mail.token}})).body.error.code, 'INVALID_ACTION_LINK');
  const profile = await f.browser.request('/account/profile'); assert.equal(profile.body.data.emailVerified, true); assert.ok(profile.body.data.emailVerifiedAt);
  assert.equal((await f.browser.request('/auth/me')).status, 200);
});

test('resend cooldown is durable and a later resend invalidates the previous action link', {skip}, async t => {
  const f = await fixture(t); const initial = await f.link('VERIFY_EMAIL');
  assert.equal((await f.browser.request('/auth/request-email-verification', {method: 'POST', body: {}})).status, 202);
  assert.equal(await f.subsystem.models.MailOutbox.countDocuments({userId: f.userId, purpose: 'VERIFY_EMAIL'}), 1);
  f.advance(61000);
  await f.browser.request('/auth/request-email-verification', {method: 'POST', body: {}}); const fresh = await f.link('VERIFY_EMAIL');
  assert.ok(fresh.token !== initial.token); assert.equal((await f.latest('VERIFY_EMAIL')).status, 'QUEUED');
  assert.equal((await f.browser.request('/auth/verify-email', {method: 'POST', body: {token: initial.token}})).body.error.code, 'INVALID_ACTION_LINK');
  assert.equal((await f.browser.request('/auth/verify-email', {method: 'POST', body: {token: fresh.token}})).status, 200);
});

test('forgot-password is generic for existing/unknown/suspended/cooldown and responds before any provider delivery', {skip}, async t => {
  const f = await fixture(t, {recoveryResponseFloorMs: 80});
  const existingStart = performance.now(); const existing = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}}); assert.ok(performance.now() - existingStart >= 70);
  const unknownStart = performance.now(); const unknown = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: 'absent-' + randomBytes(6).toString('hex') + '@example.test'}}); assert.ok(performance.now() - unknownStart >= 70);
  const cooldown = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}});
  await f.repository.models.User.updateOne({_id: f.userId}, {$set: {status: 'SUSPENDED'}});
  const suspended = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}});
  assert.equal(existing.status, 202); assert.deepEqual(existing.body.data, unknown.body.data); assert.deepEqual(existing.body.data, cooldown.body.data); assert.deepEqual(existing.body.data, suspended.body.data);
  assert.equal(await f.subsystem.models.MailOutbox.countDocuments({userId: f.userId, purpose: 'RESET_PASSWORD'}), 1);
  assert.equal((await f.latest('RESET_PASSWORD')).status, 'QUEUED');
});

test('concurrent first recovery requests retain one current link and one queued email without existence-dependent errors', {skip}, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled(Array.from({length: 6}, () => f.subsystem.service.forgotPassword(f.email)));
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.equal(await f.subsystem.models.ActionToken.countDocuments({userId: f.userId, purpose: 'RESET_PASSWORD'}), 1);
  assert.equal(await f.subsystem.models.MailOutbox.countDocuments({userId: f.userId, purpose: 'RESET_PASSWORD', status: 'QUEUED'}), 1);
  const mail = await f.link('RESET_PASSWORD');
  await f.subsystem.service.resetPassword(mail.token, nextPassword);
  assert.equal((await f.repository.findUserById(f.userId)).authVersion, 1);
});

test('forgot queue failure stays generic and rolls back token issuance instead of disclosing an existing address', {skip}, async t => {
  const failingEncrypt = () => {throw new Error('Explicit test-only encryption outage');};
  const f = await fixture(t, {}, {encryptMailImpl: failingEncrypt});
  const existing = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}});
  const unknown = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: 'unknown-' + randomBytes(6).toString('hex') + '@example.test'}});
  assert.equal(existing.status, 202); assert.equal(unknown.status, 202); assert.deepEqual(existing.body.data, unknown.body.data);
  assert.equal(await f.subsystem.models.ActionToken.countDocuments({userId: f.userId}), 0, 'Failed encrypted enqueue rolls back its action record');
  assert.equal(await f.subsystem.models.MailOutbox.countDocuments({userId: f.userId}), 0);
  assert.equal((await f.browser.request('/auth/me')).status, 200, 'Signup succeeded despite unavailable enqueue');
});

test('failed resend encryption preserves the previous active recovery link atomically', {skip}, async t => {
  const f = await fixture(t); await f.subsystem.service.forgotPassword(f.email); const previous = await f.link('RESET_PASSWORD'); f.advance(61000);
  const failingService = createAccountServices({connection, models: f.subsystem.models, config: f.config, now: f.now, encryptMail: () => {throw new Error('Explicit test-only enqueue outage');}});
  await failingService.forgotPassword(f.email);
  assert.equal(await f.subsystem.models.MailOutbox.countDocuments({userId: f.userId, purpose: 'RESET_PASSWORD'}), 1);
  assert.equal((await f.subsystem.models.ActionToken.findById(previous.row.actionId).lean()).tokenHash, previous.row.tokenHash);
  await f.subsystem.service.resetPassword(previous.token, nextPassword);
  assert.equal((await f.repository.findUserById(f.userId)).authVersion, 1);
});

test('password reset consumes once, invalidates all sessions and old links, and requires explicit new login', {skip}, async t => {
  const f = await fixture(t); const second = f.client(); await second.bootstrap();
  await second.request('/auth/login', {method: 'POST', body: {email: f.email, password: firstPassword}});
  const oldVerification = await f.link('VERIFY_EMAIL');
  await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}}); const mail = await f.link('RESET_PASSWORD');
  const reset = await f.browser.request('/auth/reset-password', {method: 'POST', body: {token: mail.token, password: nextPassword}}); assert.equal(reset.status, 200); assert.equal(reset.body.data.status, 'PASSWORD_RESET');
  assert.equal((await f.browser.request('/auth/me')).status, 401); assert.equal((await second.request('/auth/me')).status, 401);
  assert.equal((await second.request('/auth/refresh', {method: 'POST', body: {}})).status, 401);
  assert.equal(await f.repository.models.Session.countDocuments({userId: f.userId, revokedAt: null}), 0);
  assert.equal((await f.repository.findUserById(f.userId)).authVersion, 1);
  assert.equal((await f.browser.request('/auth/reset-password', {method: 'POST', body: {token: mail.token, password: nextPassword}})).body.error.code, 'INVALID_ACTION_LINK');
  assert.equal((await f.browser.request('/auth/verify-email', {method: 'POST', body: {token: oldVerification.token}})).body.error.code, 'INVALID_ACTION_LINK');
  assert.equal((await f.browser.request('/auth/login', {method: 'POST', body: {email: f.email, password: firstPassword}})).status, 401);
  assert.equal((await f.browser.request('/auth/login', {method: 'POST', body: {email: f.email, password: nextPassword}})).status, 200);
  assert.ok(await f.latest('SECURITY_NOTICE'));
});

test('reset expiry is enforced even while the token document remains in MongoDB', {skip}, async t => {
  const f = await fixture(t); await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}}); const mail = await f.link('RESET_PASSWORD');
  f.advance(1800001);
  assert.ok(await f.subsystem.models.ActionToken.findById(mail.row.actionId).lean());
  const result = await f.browser.request('/auth/reset-password', {method: 'POST', body: {token: mail.token, password: nextPassword}}); assert.equal(result.body.error.code, 'INVALID_ACTION_LINK');
  assert.equal((await f.repository.findUserById(f.userId)).authVersion, 0);
});

test('an already-issued reset link remains usable if email delivery is later disabled', {skip}, async t => {
  const f = await fixture(t); await f.subsystem.service.forgotPassword(f.email); const mail = await f.link('RESET_PASSWORD');
  f.config.mailMode = 'disabled';
  const result = await f.browser.request('/auth/reset-password', {method: 'POST', body: {token: mail.token, password: nextPassword}});
  assert.equal(result.status, 200); assert.equal((await f.repository.findUserById(f.userId)).authVersion, 1);
  assert.equal((await f.latest('SECURITY_NOTICE')).status, 'QUEUED');
});

test('two concurrent reset submissions have one winner and cannot resurrect old-session epochs', {skip}, async t => {
  const f = await fixture(t); await f.subsystem.service.forgotPassword(f.email); const mail = await f.link('RESET_PASSWORD');
  const results = await Promise.allSettled([f.subsystem.service.resetPassword(mail.token, nextPassword), f.subsystem.service.resetPassword(mail.token, 'A second possible private password. 85')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVALID_ACTION_LINK');
  const user = await f.repository.findUserById(f.userId); assert.equal(user.authVersion, 1);
  // Simulate a login whose password verification finished before the reset but
  // whose session insert arrived afterward. Epoch checking must still reject it.
  const oldSession = await f.repository.models.Session.findOne({userId: f.userId}).select('+tokenHash +usedTokenHashes').lean();
  await f.repository.models.Session.updateOne({_id: oldSession._id}, {$set: {revokedAt: null, authVersion: 0}});
  assert.equal((await f.browser.request('/auth/me')).status, 401);
  assert.equal((await f.browser.request('/auth/refresh', {method: 'POST', body: {}})).status, 401);
});

test('email changes require current password and keep current identity until new-address confirmation', {skip}, async t => {
  const f = await fixture(t); const target = 'new-' + randomBytes(6).toString('hex') + '@example.test';
  const wrong = await f.browser.request('/account/email-change', {method: 'POST', body: {email: target, currentPassword: 'a wrong password'}}); assert.equal(wrong.status, 403);
  assert.equal(await f.subsystem.models.ActionToken.countDocuments({userId: f.userId, purpose: 'CHANGE_EMAIL'}), 0);
  assert.equal((await f.browser.request('/account/email-change', {method: 'POST', body: {email: target, currentPassword: firstPassword}})).status, 202);
  const mail = await f.link('CHANGE_EMAIL'); assert.equal(mail.message.to, target); assert.equal(mail.url.pathname, '/confirm-email-change');
  const pending = await f.browser.request('/account/profile'); assert.equal(pending.body.data.user.email, f.email); assert.equal(pending.body.data.pendingEmailChange.email, target);
  assert.equal((await f.browser.request('/auth/confirm-email-change', {method: 'POST', body: {token: mail.token}})).status, 200);
  const changed = await f.repository.findUserById(f.userId); assert.equal(changed.emailNormalized, target); assert.ok(changed.emailVerifiedAt); assert.equal(changed.authVersion, 1);
  assert.equal((await f.browser.request('/auth/me')).status, 401);
  assert.equal((await f.browser.request('/auth/login', {method: 'POST', body: {email: f.email, password: firstPassword}})).status, 401);
  assert.equal((await f.browser.request('/auth/login', {method: 'POST', body: {email: target, password: firstPassword}})).status, 200);
  assert.equal((await f.browser.request('/account/profile')).body.data.pendingEmailChange, null);
  assert.equal((await f.latest('SECURITY_NOTICE')).authVersion, 1);
});

test('cancelled pending email links cannot change identity and expired pending links are hidden', {skip}, async t => {
  const f = await fixture(t); await f.subsystem.service.requestEmailChange(f.userId, 0, 'cancel-' + randomBytes(6).toString('hex') + '@example.test', firstPassword); const mail = await f.link('CHANGE_EMAIL');
  assert.equal((await f.browser.request('/account/email-change', {method: 'DELETE', body: {}})).status, 204);
  assert.equal((await f.browser.request('/account/profile')).body.data.pendingEmailChange, null);
  assert.equal((await f.browser.request('/auth/confirm-email-change', {method: 'POST', body: {token: mail.token}})).body.error.code, 'INVALID_ACTION_LINK');
  f.advance(61000); await f.subsystem.service.requestEmailChange(f.userId, 0, 'expired-' + randomBytes(6).toString('hex') + '@example.test', firstPassword); f.advance(1800001);
  assert.equal((await f.subsystem.service.profile(f.userId, 0)).pendingEmailChange, null);
});

test('email collision at confirmation rolls back token consumption and session invalidation', {skip}, async t => {
  const f = await fixture(t); const target = 'collision-' + randomBytes(6).toString('hex') + '@example.test';
  await f.subsystem.service.requestEmailChange(f.userId, 0, target, firstPassword); const mail = await f.link('CHANGE_EMAIL');
  await f.repository.createUser({displayName: 'New Address Owner', emailNormalized: target, passwordHash: await hashPassword(firstPassword), role: 'USER', status: 'ACTIVE'});
  const result = await f.browser.request('/auth/confirm-email-change', {method: 'POST', body: {token: mail.token}}); assert.equal(result.body.error.code, 'EMAIL_CHANGE_UNAVAILABLE');
  assert.equal((await f.repository.findUserById(f.userId)).emailNormalized, f.email); assert.equal((await f.repository.findUserById(f.userId)).authVersion, 0);
  assert.equal((await f.subsystem.models.ActionToken.findById(mail.row.actionId).lean()).usedAt, null);
  assert.equal((await f.browser.request('/auth/me')).status, 200);
});

test('password-reset and email-confirmation race has one committed identity/security transition', {skip}, async t => {
  const f = await fixture(t); await f.subsystem.service.forgotPassword(f.email); const reset = await f.link('RESET_PASSWORD');
  const target = 'race-' + randomBytes(6).toString('hex') + '@example.test'; await f.subsystem.service.requestEmailChange(f.userId, 0, target, firstPassword); const change = await f.link('CHANGE_EMAIL');
  const results = await Promise.allSettled([f.subsystem.service.resetPassword(reset.token, nextPassword), f.subsystem.service.confirmEmailChange(change.token)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'INVALID_ACTION_LINK');
  const user = await f.repository.findUserById(f.userId); assert.equal(user.authVersion, 1); assert.ok([f.email, target].includes(user.emailNormalized));
  assert.equal((await f.browser.request('/auth/me')).status, 401);
});

test('legacy absent user epoch is atomically advanced by password reset and public delivery unavailable is global', {skip}, async t => {
  const f = await fixture(t); await f.repository.models.User.collection.updateOne({_id: new mongoose.Types.ObjectId(f.userId)}, {$unset: {authVersion: ''}});
  await f.subsystem.service.forgotPassword(f.email); const mail = await f.link('RESET_PASSWORD'); await f.subsystem.service.resetPassword(mail.token, nextPassword);
  assert.equal((await f.repository.findUserById(f.userId)).authVersion, 1);
  const stored = await f.repository.findUserByEmail(f.email); assert.ok(await verifyPassword(stored.passwordHash, nextPassword));
  f.config.mailMode = 'disabled';
  const existing = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: f.email}});
  const absent = await f.browser.request('/auth/forgot-password', {method: 'POST', body: {email: 'unknown-' + randomBytes(6).toString('hex') + '@example.test'}});
  assert.equal(existing.status, 503); assert.equal(absent.status, 503); assert.deepEqual(existing.body.error, absent.body.error);
});
