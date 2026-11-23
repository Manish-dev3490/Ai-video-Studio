import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {loadConfig} from '../src/config.js';
import {createMongoRepository} from '../src/repository.js';
import {createAccountModels, initializeAccountModels} from '../src/account/models.js';
import {encryptMail, decryptMail, createMailTransport, dispatchMailOnce} from '../src/mail.js';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const configFor = extra => ({...loadConfig({NODE_ENV: 'test', APP_ORIGIN: 'http://127.0.0.1:5173', MONGODB_URI: 'mongodb://127.0.0.1/phase5_mail_test', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)}), ...extra});
const context = {userId: 'a'.repeat(24), purpose: 'RESET_PASSWORD', actionId: 'b'.repeat(24), tokenHash: 'c'.repeat(64), authVersion: 0};
const input = {to: 'owner@example.test', subject: 'Your private action', text: 'Open http://127.0.0.1:5173/reset-password#token=' + 'b'.repeat(24) + '.' + 'x'.repeat(43)};
const message = {...input, from: configFor().mailFrom};
async function privateDirectory(t, {cleanup = true} = {}) {
  const directory = path.join(repositoryRoot, 'var', 'mail-test-' + randomUUID());
  await fs.mkdir(directory, {recursive: true});
  if (cleanup) t.after(async () => {
    const resolved = path.resolve(directory), base = path.resolve(repositoryRoot, 'var');
    assert.ok(resolved.startsWith(base + path.sep));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  return directory;
}

test('mail AES-GCM hides action links and authenticates immutable row context', () => {
  const config = configFor();
  const first = encryptMail(input, config, context), second = encryptMail(input, config, context);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes('token='), false);
  assert.equal(JSON.stringify(first).includes(input.to), false);
  assert.deepEqual(decryptMail(first, config, context), message);
  for (const changed of [{...context, userId: 'd'.repeat(24)}, {...context, purpose: 'VERIFY_EMAIL'}, {...context, authVersion: 1}]) assert.throws(() => decryptMail(first, config, changed), {code: 'MAIL_PAYLOAD_INVALID'});
  assert.throws(() => decryptMail({...first, ciphertext: 'AAAA'}, config, context), {code: 'MAIL_PAYLOAD_INVALID'});
  assert.throws(() => decryptMail(first, {...config, jwtSecret: 'd'.repeat(64)}, context), {code: 'MAIL_PAYLOAD_INVALID'});
});

test('private local previews are idempotent and never overwrite a conflicting file', async t => {
  const directory = await privateDirectory(t);
  const send = createMailTransport(configFor({mailMode: 'local', mailPreviewRoot: directory}));
  const id = 'd'.repeat(24);
  await send(message, {messageId: id});
  await send(message, {messageId: id});
  const file = path.join(directory, id + '.json');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).text, message.text);
  await fs.writeFile(file, 'pre-existing content');
  await assert.rejects(() => send(message, {messageId: id}), {code: 'MAIL_PREVIEW_CONFLICT'});
  assert.equal(await fs.readFile(file, 'utf8'), 'pre-existing content');
});

test('local preview rejects a root escape and a child junction', async t => {
  const directory = await privateDirectory(t);
  const bad = createMailTransport(configFor({mailMode: 'local', mailPreviewRoot: repositoryRoot}));
  await assert.rejects(() => bad(message, {messageId: 'd'.repeat(24)}), {code: 'MAIL_PREVIEW_PATH_INVALID'});
  if (process.platform === 'win32') {
    const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
    const junction = path.join(directory, 'preview'); await fs.symlink(outside, junction, 'junction');
    await assert.rejects(() => createMailTransport(configFor({mailMode: 'local', mailPreviewRoot: junction}))(message, {messageId: 'd'.repeat(24)}), {code: 'ARTIFACT_INTEGRITY_FAILED'});
    assert.deepEqual(await fs.readdir(outside), []);
  }
});

test('Resend uses a fixed HTTPS target, disabled redirects and stable idempotency', async () => {
  const calls = [];
  const send = createMailTransport(configFor({mailMode: 'resend', resendApiKey: 'test-provider-secret'}), {fetchImpl: async (url, options) => {calls.push({url, options}); return Response.json({id: '37e4414c-5e25-4dbc-a071-43552a4bd53b'});}});
  const receipt = await send(message, {messageId: 'd'.repeat(24)});
  assert.deepEqual(receipt, {provider: 'EMAIL', providerMessageId: '37e4414c-5e25-4dbc-a071-43552a4bd53b', deliveryStatus: 'ACCEPTED', inboxConfirmed: false});
  await send(message, {messageId: 'd'.repeat(24)});
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(calls[0].options.body), {from: message.from, to: [message.to], subject: message.subject, text: message.text});
  for (const status of [401, 422, 429, 503]) {
    const failed = createMailTransport(configFor({mailMode: 'resend', resendApiKey: 'test'}), {fetchImpl: async () => new Response('provider internals', {status})});
    await assert.rejects(() => failed(message, {messageId: 'd'.repeat(24)}), error => error.retryable === [429, 503].includes(status) && !error.message.includes('internals'));
  }
});

test('production refuses local fallback and header-injected sender configuration', () => {
  const base = {NODE_ENV: 'production', APP_ORIGIN: 'https://studio.example.test', MONGODB_URI: 'mongodb://127.0.0.1/db', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)};
  assert.throws(() => loadConfig({...base, MAIL_TRANSPORT: 'local'}));
  assert.throws(() => loadConfig({...base, MAIL_TRANSPORT: 'resend'}));
  assert.throws(() => loadConfig({...base, MAIL_FROM: 'owner@example.test\r\nBcc: other@example.test'}));
});

const freePort = () => new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});});
test('real Mongo outbox fences competing dispatchers and suppresses stale actions', async t => {
  const directory = await privateDirectory(t, {cleanup: false}), port = await freePort();
  let mongo, connection;
  t.after(async () => {
    await connection?.close();
    await mongo?.stop();
    assert.ok(path.resolve(directory).startsWith(path.resolve(repositoryRoot, 'var') + path.sep));
    await fs.rm(directory, {recursive: true, force: true});
  });
  mongo = await startLocalMongo({directory: path.join(directory, 'mongodb'), port, replicaSet: 'mailTest'});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/phase5_mail_test?replicaSet=mailTest`, {serverSelectionTimeoutMS: 5000}).asPromise();
  const repository = createMongoRepository(connection); await repository.initialize();
  const models = {...repository.models, ...createAccountModels(connection)}; await initializeAccountModels(models);
  const user = await models.User.create({displayName: 'Mail Test', emailNormalized: message.to, passwordHash: 'test-only-not-a-live-password', status: 'ACTIVE', role: 'USER', authVersion: 0});
  let time = Date.now(); const now = () => time;
  const config = configFor({mailMode: 'local', mailPreviewRoot: path.join(directory, 'preview')});
  const action = await models.ActionToken.create({userId: user._id, purpose: 'RESET_PASSWORD', emailNormalized: user.emailNormalized, authVersion: 0, tokenHash: context.tokenHash, issuedAt: new Date(time), expiresAt: new Date(time + 60000), usedAt: null});
  const enqueue = async (overrides = {}) => {
    const ctx = {...context, userId: String(user._id), actionId: String(action._id)};
    return models.MailOutbox.create({...ctx, payload: encryptMail(input, config, ctx), status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(time), expiresAt: new Date(time + 60000), ...overrides});
  };
  await t.test('one active lease admits only one sender and terminal receipt erases ciphertext', async () => {
    const queued = await enqueue(); let calls = 0, release;
    const sending = new Promise(resolve => {release = resolve;});
    let begun; const started = new Promise(resolve => {begun = resolve;});
    const first = dispatchMailOnce({models, config, now, sendMail: async () => {calls++; begun(); await sending;}});
    await started;
    assert.equal((await dispatchMailOnce({models, config, now, sendMail: async () => {calls++;}})).delivered, false);
    release(); assert.equal((await first).delivered, true); assert.equal(calls, 1);
    const saved = await models.MailOutbox.findById(queued._id).lean(); assert.equal(saved.status, 'SENT'); assert.equal(saved.payload, undefined);
  });
  await t.test('provider acceptance retains only a private receipt and erases the encrypted action body', async () => {
    const queued = await enqueue();
    const id = '37e4414c-5e25-4dbc-a071-43552a4bd53b';
    assert.equal((await dispatchMailOnce({models, config, now, sendMail: async () => ({provider: 'EMAIL', providerMessageId: id, deliveryStatus: 'ACCEPTED', inboxConfirmed: false})})).delivered, true);
    const saved = await models.MailOutbox.findById(queued._id).lean(); assert.equal(saved.providerMessageId, id); assert.ok(saved.providerAcceptedAt); assert.equal(saved.payload, undefined);
  });
  await t.test('a replaced token suppresses a queued action without delivery', async () => {
    const queued = await enqueue(); await models.ActionToken.updateOne({_id: action._id}, {$set: {tokenHash: 'e'.repeat(64)}});
    let calls = 0; assert.equal((await dispatchMailOnce({models, config, now, sendMail: async () => {calls++;}})).cancelled, true); assert.equal(calls, 0);
    assert.equal((await models.MailOutbox.findById(queued._id).lean()).status, 'CANCELLED');
    await models.ActionToken.updateOne({_id: action._id}, {$set: {tokenHash: context.tokenHash}});
  });
  await t.test('provider retry keeps the same identity and stops after bounded failures', async () => {
    const queued = await enqueue(); const ids = [];
    const fail = async (payload, options) => {ids.push(options.messageId); throw Object.assign(new Error('test provider transient failure'), {code: 'EMAIL_PROVIDER_BUSY', retryable: true});};
    for (let index = 0; index < 3; index++) {await dispatchMailOnce({models, config, now, sendMail: fail}); time += 20000;}
    const saved = await models.MailOutbox.findById(queued._id).lean(); assert.equal(saved.status, 'FAILED'); assert.equal(saved.attempts, 3); assert.equal(saved.payload, undefined); assert.equal(new Set(ids).size, 1);
  });
  await t.test('expired final-attempt lease settles without sending and erases ciphertext', async () => {
    const queued = await enqueue({status: 'SENDING', attempts: 3, leaseUntil: new Date(time - 1), expiresAt: new Date(time + 60000)});
    await dispatchMailOnce({models, config, now, sendMail: async () => {assert.fail('must not send');}});
    const saved = await models.MailOutbox.findById(queued._id).lean(); assert.equal(saved.status, 'FAILED'); assert.equal(saved.payload, undefined);
  });
});
