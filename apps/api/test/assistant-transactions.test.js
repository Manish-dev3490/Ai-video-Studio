import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {createAssistantServices, readAssistantContext, cleanupAssistantHistory} from '../src/assistant/index.js';
import {ApiError} from '../src/http.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const settings = {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS', characterAssetId: null};
const owner = String(new mongoose.Types.ObjectId()), other = String(new mongoose.Types.ObjectId());
const reply = {assistantMessage: 'I can help shape a clear explanation.', suggestedSettings: {durationSec: 60}, missingInformation: ['Who is the audience?']};
const config = {csrfSecret: 'assistant cursor and receipt test key'.repeat(2), jwtSecret: 'assistant auth test secret'.repeat(2), assistantTimeoutMs: 1000, assistantDailyLimit: 100, assistantMaxMessages: 200, assistantMaxConcurrent: 2};
let connection, mongo, models;
const newId = () => String(new mongoose.Types.ObjectId());
before(async () => {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
  const directory = path.join(root, 'var', 'assistant-transactions-' + Date.now());
  await fs.mkdir(directory, {recursive: true});
  mongo = await startLocalMongo({directory, port, replicaSet: 'assistantTest'});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/assistant_test?replicaSet=assistantTest`, {serverSelectionTimeoutMS: 5000}).asPromise();
  models = createStudioModels(connection); await initializeStudioModels(models);
});
after(async () => {if (connection) await connection.close(); if (mongo) await mongo.stop();});
async function project(user = owner, extra = {}) {return (await models.Project.create({ownerId: user, title: 'Assistant test project', prompt: 'Explain a topic clearly.', settings, ...extra})).toObject();}
const service = (assistant = async () => reply, extra = {}, now) => createAssistantServices({connection, config: {...config, ...extra}, models, assistant, ...(now ? {now} : {})});
const send = (api, item, message = 'Help me make this clear.', key = randomUUID(), options = {}) => api.send(String(item.ownerId), {projectId: String(item._id), message}, {idempotencyKey: key, ...options});
function gate() {let resolve, started; const wait = new Promise(done => {resolve = done;}); const begun = new Promise(done => {started = done;}); return {wait, begun, resolve, started};}

test('a successful assistant turn atomically publishes ordered history without mutating settings/approval', async () => {
  const approved = new mongoose.Types.ObjectId();
  const item = await project(owner, {currentStoryboardId: approved}); let calls = 0;
  const api = service(async input => {calls++; assert.deepEqual(input.history, []); return reply;});
  const result = await send(api, item);
  assert.deepEqual(Object.keys(result).sort(), ['assistantMessage', 'conversationRevision', 'missingInformation', 'suggestedSettings']);
  assert.equal(result.conversationRevision, 2); assert.ok(result.assistantMessage.includes('Who is the audience?'));
  const saved = await models.Project.findById(item._id).lean(); assert.equal(saved.settings.durationSec, 30); assert.equal(String(saved.currentStoryboardId), String(approved)); assert.equal(saved.assistantConversationRevision, 2); assert.equal(saved.assistantLeaseToken, null);
  const page = await api.history(owner, String(item._id)); assert.deepEqual(page.messages.map(message => [message.role, message.conversationRevision]), [['USER', 1], ['ASSISTANT', 2]]); assert.equal(page.nextCursor, null); assert.equal(calls, 1);
});
test('receipts replay before capacity/quota and reject body/key conflicts', async () => {
  const item = await project(newId()); let calls = 0; const key = randomUUID(); const api = service(async () => {calls++; return reply;}, {assistantDailyLimit: 1});
  const first = await send(api, item, 'A clear first question.', key);
  assert.deepEqual(await send(api, item, 'A clear first question.', key), first);
  assert.deepEqual(await send(service(async () => {assert.fail('no provider on replay');}, {assistantDailyLimit: 0}), item, 'A clear first question.', key, {replayOnly: true}), first);
  await assert.rejects(send(api, item, 'Different text.', key), {code: 'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(send(api, item, 'A fresh question.'), {code: 'AI_QUOTA_EXCEEDED'});
  assert.equal(calls, 1); assert.equal((await models.AssistantUsageBucket.findOne({ownerId: item.ownerId}).lean()).count, 1);
});
test('replay-only lookup never admits an unknown request', async () => {
  const item = await project(newId()); const api = service(async () => {assert.fail('replay check cannot invoke provider');});
  await assert.rejects(send(api, item, 'Check an unknown request.', randomUUID(), {replayOnly: true}), {code: 'ASSISTANT_REQUEST_NOT_FOUND'});
  assert.equal(await models.AssistantRequest.countDocuments({projectId: item._id}), 0); assert.equal(await models.AssistantUsageBucket.countDocuments({ownerId: item.ownerId}), 0);
});
test('concurrent same-key and other-key turns cannot duplicate paid work or history', async () => {
  const item = await project(newId()); const waiting = gate(); const key = randomUUID(); let calls = 0;
  const api = service(async () => {calls++; waiting.started(); await waiting.wait; return reply;});
  const first = send(api, item, 'First request.', key); await waiting.begun;
  await assert.rejects(send(api, item, 'First request.', key, {replayOnly: true}), error => error.code === 'ASSISTANT_REQUEST_IN_PROGRESS' && error.details.requestAccepted === true);
  await assert.rejects(send(api, item, 'Second request.'), error => error.code === 'ASSISTANT_IN_PROGRESS' && error.details.requestAccepted === false);
  waiting.resolve(); await first;
  assert.equal(calls, 1); assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 2);
});
test('cold same-key requests and first-use quota buckets remain race-safe', async () => {
  const user = newId(), item = await project(user); let calls = 0; const key = randomUUID();
  const api = service(async () => {calls++; return reply;});
  const outcomes = await Promise.allSettled([send(api, item, 'A concurrent first question.', key), send(api, item, 'A concurrent first question.', key)]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled'));
  for (const result of outcomes.filter(value => value.status === 'rejected')) assert.equal(result.reason.code, 'ASSISTANT_REQUEST_IN_PROGRESS');
  assert.equal(calls, 1); assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 2); assert.equal((await models.AssistantUsageBucket.findOne({ownerId: user}).lean()).count, 1);
  const secondUser = newId(), firstProject = await project(secondUser), secondProject = await project(secondUser);
  const parallel = await Promise.all([send(api, firstProject), send(api, secondProject)]);
  assert.deepEqual(parallel.map(value => value.conversationRevision), [2, 2]);
  assert.equal((await models.AssistantUsageBucket.findOne({ownerId: secondUser}).lean()).count, 2);
});
test('a partial message-write failure rolls back the whole transcript and project revision', async () => {
  const item = await project(newId()); const api = service(); const create = models.AssistantMessage.create;
  models.AssistantMessage.create = async function (documents, options) {
    await create.call(this, [documents[0]], options);
    throw new Error('Explicit test-only write fault after first staged message');
  };
  try {await assert.rejects(send(api, item), {status: 503});} finally {models.AssistantMessage.create = create;}
  assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 0);
  const saved = await models.Project.findById(item._id).lean(); assert.equal(saved.assistantConversationRevision, 0); assert.equal(saved.assistantLeaseToken, null);
  assert.equal((await models.AssistantRequest.findOne({projectId: item._id}).lean()).status, 'FAILED');
});
test('global in-flight cap rejects unaccepted work without a quota charge', async () => {
  const first = await project(newId()), second = await project(newId()), third = await project(newId());
  const one = gate(), two = gate(); let calls = 0;
  const api = service(async () => {calls++; const block = calls === 1 ? one : two; block.started(); await block.wait; return reply;});
  const a = send(api, first); await one.begun; const b = send(api, second); await two.begun;
  try {await assert.rejects(send(api, third), error => error.code === 'AI_BUSY' && error.details.requestAccepted === false); assert.equal(await models.AssistantUsageBucket.countDocuments({ownerId: third.ownerId}), 0);} finally {one.resolve(); two.resolve();}
  await Promise.all([a, b]); assert.equal(calls, 2);
});
test('provider failure and invalid output persist no partial transcript and charge one accepted request', async () => {
  for (const failure of [async () => {throw new Error('private provider stack and credential must not escape');}, async () => ({...reply, ownerId: owner})]) {
    const item = await project(newId()); const key = randomUUID(); const api = service(failure);
    await assert.rejects(send(api, item, 'Please answer.', key), error => error.status >= 500 && !error.message.includes('credential'));
    assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 0);
    assert.equal((await models.AssistantRequest.findOne({projectId: item._id}).lean()).status, 'FAILED');
    assert.equal((await models.AssistantUsageBucket.findOne({ownerId: item.ownerId}).lean()).count, 1);
    await assert.rejects(send(api, item, 'Please answer.', key), error => error.status >= 500);
    assert.equal((await models.AssistantUsageBucket.findOne({ownerId: item.ownerId}).lean()).count, 1);
  }
});
test('unsafe or credential-bearing input/project context is rejected before quota or provider use', async () => {
  const item = await project(newId()); const api = service(async () => {assert.fail('rejected input must stay local');});
  for (const message of ['API_KEY=' + 'X'.repeat(24), 'How to build a working bomb step by step']) await assert.rejects(send(api, item, message), {status: 422});
  await models.Project.updateOne({_id: item._id}, {$set: {prompt: 'API_KEY=' + 'X'.repeat(24)}});
  await assert.rejects(send(api, item, 'A harmless follow-up.'), {code: 'SENSITIVE_INPUT'});
  assert.equal(await models.AssistantUsageBucket.countDocuments({ownerId: item.ownerId}), 0);
});
test('project settings/deletion during inference fence stale publication', async () => {
  for (const remove of [false, true]) {
    const item = await project(newId()); const waiting = gate(); const api = service(async () => {waiting.started(); await waiting.wait; return reply;});
    const pending = send(api, item); await waiting.begun;
    await models.Project.updateOne({_id: item._id}, {$set: remove ? {deletedAt: new Date()} : {'settings.durationSec': 90}});
    waiting.resolve(); await assert.rejects(pending, {code: remove ? 'NOT_FOUND' : 'PROJECT_CHANGED'});
    assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 0);
  }
});
test('legacy missing revision defaults to zero, expired requests are not silently re-executed', async () => {
  let time = Date.now(); const item = await project(newId());
  await models.Project.collection.updateOne({_id: item._id}, {$unset: {assistantConversationRevision: '', assistantLeaseToken: '', assistantLeaseExpiresAt: ''}});
  const waiting = gate(); let calls = 0; const api = service(async () => {calls++; waiting.started(); await waiting.wait; return reply;}, {}, () => time);
  const key = randomUUID(); const pending = send(api, item, 'Original request.', key); await waiting.begun;
  time += 121000;
  await assert.rejects(send(api, item, 'Original request.', key, {replayOnly: true}), {code: 'ASSISTANT_REQUEST_EXPIRED'});
  waiting.resolve(); await assert.rejects(pending, {code: 'ASSISTANT_REQUEST_EXPIRED'});
  assert.equal(calls, 1); assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 0);
  assert.equal((await models.AssistantRequest.findOne({projectId: item._id}).lean()).status, 'FAILED');
  assert.equal((await send(service(async () => reply, {}, () => time), item, 'A new accepted request.')).conversationRevision, 2);
});
test('history pagination is ascending, scoped and immutable across new turns', async () => {
  const item = await project(newId()); const api = service();
  for (let index = 0; index < 3; index++) await send(api, item, `Question ${index}.`);
  const first = await api.history(String(item.ownerId), String(item._id), {limit: '3'}); assert.deepEqual(first.messages.map(m => m.conversationRevision), [1, 2, 3]); assert.ok(first.nextCursor);
  await send(api, item, 'A newer fourth question.');
  const second = await api.history(String(item.ownerId), String(item._id), {limit: '3', cursor: first.nextCursor}); assert.deepEqual(second.messages.map(m => m.conversationRevision), [4, 5, 6]);
  const third = await api.history(String(item.ownerId), String(item._id), {limit: '3', cursor: second.nextCursor}); assert.deepEqual(third.messages.map(m => m.conversationRevision), [7, 8]); assert.equal(third.nextCursor, null);
  await assert.rejects(api.history(other, String(item._id)), {status: 404});
  const another = await project(item.ownerId); await assert.rejects(api.history(String(item.ownerId), String(another._id), {cursor: first.nextCursor}), {code: 'INVALID_CURSOR'});
  await assert.rejects(api.history(String(item.ownerId), String(item._id), {cursor: first.nextCursor + 'x'}), {code: 'INVALID_CURSOR'});
});
test('provider context is bounded while full saved history stays available', async () => {
  const item = await project(newId()); let context;
  const api = service(async input => {context = input.history; return {assistantMessage: 'A'.repeat(3900), suggestedSettings: {}, missingInformation: []};});
  for (let index = 0; index < 5; index++) await send(api, item, String(index) + ' ' + 'Q'.repeat(1900));
  const current = await models.Project.findById(item._id).lean();
  const bounded = await readAssistantContext({models, project: current, config});
  assert.ok(bounded.messages.length <= 12); assert.ok(bounded.messages.reduce((sum, m) => sum + m.content.length, 0) <= 16000); assert.equal(bounded.messages[0].role, 'USER');
  assert.ok(context.length < 8); assert.equal((await api.history(String(item.ownerId), String(item._id), {limit: '50'})).messages.length, 10);
});
test('conversation cap and active planning prevent fresh upstream work without truncating history', async () => {
  const item = await project(newId()); const api = service(undefined, {assistantMaxMessages: 2}); await send(api, item);
  await assert.rejects(send(api, item, 'Another question.'), {code: 'CONVERSATION_LIMIT'}); assert.equal(await models.AssistantMessage.countDocuments({projectId: item._id}), 2);
  const planning = await project(newId(), {planningToken: 'a live script generation', planningExpiresAt: new Date(Date.now() + 60000)});
  await assert.rejects(send(service(async () => {assert.fail('planning fence');}), planning), {code: 'PLANNING_IN_PROGRESS'});
  assert.equal(await models.AssistantUsageBucket.countDocuments({ownerId: planning.ownerId}), 0);
});
test('deleted history revokes access and bounded cleanup advances past completed projects', async () => {
  const first = await project(newId()), second = await project(newId()); const api = service(); await send(api, first); await send(api, second);
  await models.Project.updateMany({_id: {$in: [first._id, second._id]}}, {$set: {deletedAt: new Date()}});
  await assert.rejects(api.history(String(first.ownerId), String(first._id)), {status: 404});
  // Other deleted projects from earlier cases are harmless; completed markers
  // ensure bounded janitor passes eventually reach every deleted project.
  for (let index = 0; index < 10 && await models.AssistantMessage.countDocuments({projectId: {$in: [first._id, second._id]}}); index++) await cleanupAssistantHistory({models, limit: 1});
  assert.equal(await models.AssistantMessage.countDocuments({projectId: {$in: [first._id, second._id]}}), 0);
  assert.equal(await models.AssistantRequest.countDocuments({projectId: {$in: [first._id, second._id]}}), 0);
});
