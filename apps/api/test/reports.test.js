import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {createReportService} from '../src/reports/service.js';
import {createOperatorReviewService} from '../src/reports/operator.js';
import {validateReport} from '../src/reports/validation.js';
import {parseOperatorArguments} from '../../../scripts/operator-review.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const newId = () => String(new mongoose.Types.ObjectId());
const settings = {mode: 'FACELESS', durationSec: 30, language: 'en', aspectRatio: '16:9', tone: 'EDUCATIONAL', visualStyle: 'MOTION_GRAPHICS', characterAssetId: null};
const config = {reportDailyLimit: 10, geminiApiKey: 'bare configured secret kept out of reports', csrfSecret: 'standalone test csrf secret not persisted'};
let connection, mongo, models;
before(async () => {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const port = server.address().port; server.close(() => resolve(port));});});
  const directory = path.join(root, 'var/phase7-tests', 'reports-' + Date.now());
  await fs.mkdir(directory, {recursive: true});
  mongo = await startLocalMongo({directory, port, replicaSet: 'phase7Reports'});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/reports?replicaSet=phase7Reports`, {serverSelectionTimeoutMS: 5000}).asPromise();
  models = createStudioModels(connection); await initializeStudioModels(models);
});
after(async () => {if (connection) await connection.close(); if (mongo) await mongo.stop();});
const intake = overrides => createReportService({connection, models, config, ...overrides});
const operators = () => createOperatorReviewService({connection, models, config});
const body = target => ({projectId: target ?? newId(), reasonCode: 'SAFETY', description: 'Please review the educational output for unsafe claims.'});
const act = (report, action, expectedRevision = 0, overrides = {}) => operators().act({id: report.id, action, expectedRevision, operatorId: 'local.operator', note: 'Reviewed this case privately.', ...overrides});
const project = extra => models.Project.create({ownerId: newId(), title: 'Private moderation test', prompt: 'Explain the water cycle for students.', settings, ...extra});

test('report validation accepts exactly one canonical target and rejects untrusted fields', () => {
  assert.equal(validateReport(body()).reasonCode, 'SAFETY');
  for (const input of [null, [], {}, {...body(), ownerId: newId()}, {...body(), status: 'RESOLVED'}, {...body(), projectId: 'ABCDEFABCDEFABCDEFABCDEF'}, {...body(), assetId: newId()}, {...body(), reasonCode: 'unknown'}, {...body(), description: ' '}, {...body(), description: 'x'.repeat(2001)}, {...body(), description: '\u001b[31mterminal escape'}]) assert.throws(() => validateReport(input), {code: 'VALIDATION_FAILED'});
  assert.equal(validateReport({...body(), description: '😀'.repeat(2000)}).description.length, 4000);
});

test('unsafe quotations can be reported while credentials and configured secrets stay out', async () => {
  const input = {...body(), description: 'The output says how to build a working bomb step by step. Please remove it.'};
  const result = await intake().submit(newId(), input); assert.equal(result.status, 'OPEN');
  for (const description of ['API_KEY=' + 'X'.repeat(24), config.geminiApiKey, config.csrfSecret]) await assert.rejects(intake().submit(newId(), {...input, description}), {code: 'SENSITIVE_INPUT'});
});

test('owned, foreign, deleted, missing project and asset identifiers get identical receipts', async () => {
  const owned = await project(), foreign = await project(), deleted = await project({deletedAt: new Date()});
  const reporter = String(owned.ownerId);
  const targets = [body(String(owned._id)), body(String(foreign._id)), body(String(deleted._id)), body(), {assetId: newId(), reasonCode: 'PRIVACY', description: 'Please review this reported asset.'}];
  for (const input of targets) {
    const receipt = await intake().submit(reporter, input);
    assert.deepEqual(Object.keys(receipt).sort(), ['createdAt', 'id', 'status']); assert.equal(receipt.status, 'OPEN');
    const stored = await models.ContentReport.findById(receipt.id).lean(); assert.equal(stored.ownerId, null);
  }
});

test('durable daily intake limit admits at most ten under concurrency and resets at UTC midnight', async () => {
  const reporter = newId(); const outcomes = await Promise.allSettled(Array.from({length: 18}, () => intake().submit(reporter, body())));
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 10);
  for (const value of outcomes.filter(value => value.status === 'rejected')) assert.equal(value.reason.code, 'REPORT_DAILY_LIMIT');
  assert.equal(await models.ContentReport.countDocuments({reporterId: reporter}), 10);
  assert.equal((await models.ReportUsageBucket.findOne({reporterId: reporter}).lean()).count, 10);
  const tomorrow = new Date(Date.now() + 86400000);
  assert.equal((await intake({now: () => tomorrow}).submit(reporter, body())).status, 'OPEN');
});

test('private list omits descriptions and target ownership, and review transitions require revisions', async () => {
  const report = await intake().submit(newId(), body());
  const list = await operators().list(); assert.ok(list.length); assert.ok(list.every(item => !('description' in item) && !('reporterId' in item) && !('target' in item)));
  await assert.rejects(act(report, 'RESOLVE'), {code: 'REVIEW_CONFLICT'});
  const reviewed = await act(report, 'REVIEW'); assert.equal(reviewed.status, 'REVIEWED'); assert.equal(reviewed.revision, 1);
  await assert.rejects(act(report, 'REVIEW', 0), {code: 'REVIEW_CONFLICT'});
  const resolved = await act(report, 'RESOLVE', 1); assert.equal(resolved.status, 'RESOLVED'); assert.equal(resolved.revision, 2); assert.ok(resolved.resolvedAt);
  const shown = await operators().show(report.id); assert.equal(shown.audit.length, 2); assert.equal(shown.audit[0].action, 'RESOLVE');
  assert.equal(await models.OperatorReviewAudit.countDocuments({reportId: report.id}), 2);
});

test('competing private review actions commit exactly one event', async () => {
  const report = await intake().submit(newId(), body());
  const results = await Promise.allSettled([act(report, 'REVIEW'), act(report, 'REVIEW')]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'REVIEW_CONFLICT');
  assert.equal(await models.OperatorReviewAudit.countDocuments({reportId: report.id}), 1);
});

test('operator validation prevents arbitrary commands, missing attribution and secret notes', async () => {
  const report = await intake().submit(newId(), body());
  for (const override of [{operatorId: ''}, {operatorId: 'bad\noperator'}, {expectedRevision: -1}, {action: 'SUSPEND'}, {note: ' '}, {note: 'API_KEY=' + 'X'.repeat(24)}, {note: config.geminiApiKey}]) await assert.rejects(act(report, 'REVIEW', 0, override), error => ['VALIDATION_FAILED', 'SENSITIVE_INPUT'].includes(error.code));
  assert.equal(await models.OperatorReviewAudit.countDocuments({reportId: report.id}), 0);
  for (const args of [['hold'], ['hold', '--id', report.id], ['list', '--uri', 'private'], ['show', '--id', report.id, '--id', report.id], ['review', '--id', report.id, '--revision', '0', '--operator', 'root'], ['list', '--limit', '100']]) assert.throws(() => parseOperatorArguments(args));
  assert.equal(parseOperatorArguments(['--help']).command, 'help');
  assert.deepEqual(parseOperatorArguments(['show', '--id', report.id]), {command: 'show', id: report.id});
});

test('unverified targets and mismatched asset ownership cannot trigger enforcement', async () => {
  const report = await intake().submit(newId(), body()); await assert.rejects(act(report, 'HOLD'), {code: 'REVIEW_CONFLICT'});
  const item = await project();
  const asset = await models.MediaAsset.create({ownerId: newId(), projectId: item._id, generationId: newId(), kind: 'VIDEO_EXPORT', status: 'READY', mimeType: 'video/mp4', byteSize: 10, sha256: 'a'.repeat(64), storage: {provider: 'LOCAL', key: 'private/' + newId()}, expiresAt: new Date(Date.now() + 86400000)});
  const mismatch = await intake().submit(newId(), {assetId: String(asset._id), reasonCode: 'PRIVACY', description: 'Review this asset.'}); await assert.rejects(act(mismatch, 'HOLD'), {code: 'REVIEW_CONFLICT'});
  assert.equal((await models.Project.findById(item._id).lean()).safetyHoldAt, null);
});

test('hold cancels queued work, refunds its reservation and fences in-flight AI; release does not restart', async () => {
  const item = await project({planningToken: 'temporary-plan-lease', assistantLeaseToken: 'temporary-assistant-lease'});
  const generationId = newId(), bucketId = newId(), reservationId = newId();
  await models.QueueState.updateOne({_id: 'generation-capacity'}, {$set: {activeCount: 1, runningJobId: null}}, {upsert: true});
  await models.UsageBucket.create({_id: bucketId, userId: item.ownerId, periodStart: new Date('2026-11-21T00:00:00Z'), limit: 3, reserved: 1, consumed: 0});
  await models.Reservation.create({_id: reservationId, ownerId: item.ownerId, generationId, bucketId, state: 'RESERVED'});
  await models.GenerationJob.create({_id: generationId, ownerId: item.ownerId, projectId: item._id, storyboardId: newId(), approvedRevision: 1, snapshot: {}, status: 'QUEUED', reservationId, bucketId});
  await models.Project.updateOne({_id: item._id}, {$set: {activeGenerationId: generationId, phase: 'RENDERING'}});
  const report = await intake().submit(newId(), body(String(item._id)));
  await act(report, 'HOLD');
  const held = await models.Project.findById(item._id).lean(); assert.ok(held.safetyHoldAt); assert.equal(held.planningToken, null); assert.equal(held.assistantLeaseToken, null); assert.equal(held.safetyRevision, 1); assert.equal(held.version, 1);
  assert.equal((await models.GenerationJob.findById(generationId).lean()).status, 'CANCELLED'); assert.equal((await models.Reservation.findById(reservationId).lean()).state, 'RELEASED'); assert.equal((await models.UsageBucket.findById(bucketId).lean()).reserved, 0); assert.equal((await models.QueueState.findById('generation-capacity').lean()).activeCount, 0);
  await act(report, 'RESOLVE', 1); assert.ok((await models.Project.findById(item._id).lean()).safetyHoldAt);
  await act(report, 'RELEASE', 2); const released = await models.Project.findById(item._id).lean(); assert.equal(released.safetyHoldAt, null); assert.equal(released.safetyRevision, 2); assert.equal(released.version, 2); assert.equal((await models.GenerationJob.findById(generationId).lean()).status, 'CANCELLED');
});

test('hold requests running work to stop and another case cannot release it', async () => {
  const item = await project(), generationId = newId();
  await models.GenerationJob.create({_id: generationId, ownerId: item.ownerId, projectId: item._id, storyboardId: newId(), approvedRevision: 1, snapshot: {}, status: 'PROCESSING', lease: {fencingToken: 'owned-execution'}});
  const report = await intake().submit(newId(), body(String(item._id))), other = await intake().submit(newId(), body(String(item._id)));
  await act(report, 'HOLD'); assert.equal((await models.GenerationJob.findById(generationId).lean()).status, 'CANCEL_REQUESTED');
  await assert.rejects(act(other, 'RELEASE'), {code: 'REVIEW_CONFLICT'}); await assert.rejects(act(other, 'HOLD'), {code: 'REVIEW_CONFLICT'});
});

test('legacy private report text is redacted before operator display', async () => {
  const report = await intake().submit(newId(), body());
  await models.ContentReport.collection.updateOne({_id: new mongoose.Types.ObjectId(report.id)}, {$set: {description: 'API_KEY=' + 'X'.repeat(24)}});
  assert.equal((await operators().show(report.id)).description, '[withheld]');
  await models.ContentReport.collection.updateOne({_id: new mongoose.Types.ObjectId(report.id)}, {$set: {description: config.geminiApiKey}});
  assert.equal((await operators().show(report.id)).description, '[withheld]');
  await models.ContentReport.collection.updateOne({_id: new mongoose.Types.ObjectId(report.id)}, {$set: {description: 'Legacy\u009bcontrol\u202Etext'}});
  assert.equal((await operators().show(report.id)).description, 'Legacy control text');
});
