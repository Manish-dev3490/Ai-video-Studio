import test from 'node:test';
import assert from 'node:assert/strict';
import {clearReportSessions, createReportRequest, reportError, reportFormErrors, reportOutcomeUncertain, reportPayload, reportPrivacyVersion, subscribeReportPrivacy} from '../src/lib/reports.js';
import {friendlyError} from '../src/lib/forms.js';

const fields = {targetKind: 'projectId', targetId: 'a'.repeat(24), reasonCode: 'SAFETY', description: 'Please review this unsafe instruction.'};
const accepted = {id: 'b'.repeat(24), status: 'OPEN', createdAt: '2026-11-21T00:00:00.000Z'};
const response = (status, data) => new Response(JSON.stringify(status < 400 ? {data} : {error: data}), {status, headers: {'Content-Type': 'application/json'}});

test('reports require one bounded target and a supported reason without probing its existence', () => {
  assert.deepEqual(reportFormErrors(fields), {});
  assert.deepEqual(reportPayload({...fields, targetId: ' ' + fields.targetId + ' ', description: '  Report text  ', ownerId: 'client-supplied-owner'}), {projectId: fields.targetId, reasonCode: 'SAFETY', description: 'Report text'});
  assert.deepEqual(reportPayload({...fields, targetKind: 'assetId'}), {assetId: fields.targetId, reasonCode: 'SAFETY', description: fields.description});
  for (const targetId of ['', 'A'.repeat(24), '../private', 'https://example.test/file', 'a'.repeat(25)]) assert.ok(reportFormErrors({...fields, targetId}).targetId);
  assert.ok(reportFormErrors({...fields, targetKind: 'ownerId'}).targetId);
  assert.ok(reportFormErrors({...fields, reasonCode: 'DELETE_ACCOUNT'}).reasonCode);
});

test('report descriptions count Unicode code points and reject malformed controls or credentials', () => {
  assert.deepEqual(reportFormErrors({...fields, description: '😀'.repeat(2000)}), {});
  for (const description of [' ', '\u0000', '\ud800', '😀'.repeat(2001)]) assert.ok(reportFormErrors({...fields, description}).description);
  assert.deepEqual(reportFormErrors({...fields, description: 'The video quotes unsafe text.\nPlease review it.'}), {});
  const syntheticSecret = 'AIza' + 'x'.repeat(35);
  for (const description of [syntheticSecret, syntheticSecret.slice(0, 8) + '\u200B' + syntheticSecret.slice(8), 'password=' + 'x'.repeat(16), '-----BEGIN PRIVATE KEY-----']) assert.match(reportFormErrors({...fields, description}).description, /credentials/iu);
});

test('private report submission sends only its POST body using session cookies and CSRF', async () => {
  const calls = [];
  const submit = createReportRequest({locks: null, fetchImpl: async (url, options) => {
    calls.push({url, options});
    return url.endsWith('/csrf') ? response(200, {csrfToken: 'proof'}) : response(201, {...accepted, ownerId: 'private', description: 'not retained'});
  }});
  assert.deepEqual(await submit(fields), accepted);
  assert.deepEqual(calls.map(call => call.url), ['/api/v1/auth/csrf', '/api/v1/reports']);
  assert.ok(calls.every(call => call.options.credentials === 'include' && !call.url.includes(fields.targetId)));
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'proof');
  assert.deepEqual(JSON.parse(calls[1].options.body), {projectId: fields.targetId, reasonCode: fields.reasonCode, description: fields.description});
});

test('invalid report form never reaches either CSRF or intake', async () => {
  let calls = 0;
  const submit = createReportRequest({locks: null, fetchImpl: async () => {calls++; throw new Error('unexpected');}});
  await assert.rejects(submit({...fields, description: ''}), /report fields/iu);
  assert.equal(calls, 0);
});

test('expired authentication refreshes once and then repeats only the original report POST', async () => {
  let authenticated = false, writes = 0, refreshes = 0;
  const submit = createReportRequest({locks: null, fetchImpl: async url => {
    if (url.endsWith('/csrf')) return response(200, {csrfToken: 'proof'});
    if (url.endsWith('/me')) return response(401, {code: 'AUTH_REQUIRED'});
    if (url.endsWith('/refresh')) {authenticated = true; refreshes++; return response(200, {user: {id: 'owner'}});}
    assert.equal(url, '/api/v1/reports'); writes++;
    return authenticated ? response(201, accepted) : response(401, {code: 'AUTH_REQUIRED'});
  }});
  assert.deepEqual(await submit(fields), accepted);
  assert.equal(writes, 2); assert.equal(refreshes, 1);
});

test('session privacy reset aborts pending reports and fences even an ignored abort response', async () => {
  let finish, started;
  const ready = new Promise(resolve => {started = resolve;});
  const received = new Promise(resolve => {finish = resolve;});
  let reportSignal;
  const submit = createReportRequest({locks: null, fetchImpl: async (url, options) => {
    if (url.endsWith('/csrf')) return response(200, {csrfToken: 'proof'});
    reportSignal = options.signal; started(); return received;
  }});
  let notifications = 0;
  const unsubscribe = subscribeReportPrivacy(() => notifications++);
  const version = reportPrivacyVersion();
  const pending = submit(fields);
  const rejected = assert.rejects(pending, error => error.status === 'PRIVACY_RESET');
  await ready; clearReportSessions();
  assert.equal(reportSignal.aborted, true);
  assert.equal(reportPrivacyVersion(), version + 1); assert.equal(notifications, 1);
  finish(response(201, accepted)); await rejected; unsubscribe();
  clearReportSessions(); assert.equal(notifications, 1);
});

test('unconfirmed outcomes require explicit handling and are never automatically retried', async () => {
  let writes = 0;
  const submit = createReportRequest({locks: null, fetchImpl: async url => {
    if (url.endsWith('/csrf')) return response(200, {csrfToken: 'proof'});
    writes++; return new Response('<html>broken gateway</html>', {status: 502});
  }});
  await assert.rejects(submit(fields), error => error.status === 'PARSING_ERROR');
  assert.equal(writes, 1);
  for (const error of [{status: 'FETCH_ERROR'}, {status: 'TIMEOUT_ERROR'}, {status: 'PARSING_ERROR'}, {status: 503}]) assert.equal(reportOutcomeUncertain(error), true);
  for (const error of [{status: 422}, {status: 429}, {status: 'PRIVACY_RESET'}]) assert.equal(reportOutcomeUncertain(error), false);
});

test('session reset while CSRF is bootstrapping prevents the report POST altogether', async () => {
  let finish, started, writes = 0;
  const ready = new Promise(resolve => {started = resolve;});
  const received = new Promise(resolve => {finish = resolve;});
  const submit = createReportRequest({locks: null, fetchImpl: async url => {
    if (url.endsWith('/csrf')) {started(); return received;}
    writes++; return response(201, accepted);
  }});
  const pending = submit(fields);
  const rejected = assert.rejects(pending, error => error.status === 'PRIVACY_RESET');
  await ready; clearReportSessions(); finish(response(200, {csrfToken: 'stale-proof'}));
  await rejected; assert.equal(writes, 0);
});

test('report and safety messages show safe explanations rather than raw server diagnostics', () => {
  assert.match(reportError({status: 429, data: {error: {code: 'REPORT_DAILY_LIMIT'}}}), /UTC day/u);
  assert.match(reportError({status: 422, data: {error: {code: 'SENSITIVE_INPUT'}}}), /credentials/u);
  assert.doesNotMatch(reportError({status: 500, data: {error: {message: 'private database diagnostic'}}}), /diagnostic/u);
  assert.match(friendlyError({status: 423, data: {error: {code: 'CONTENT_UNAVAILABLE'}}}), /safety review/u);
  assert.match(friendlyError({status: 422, data: {error: {code: 'CONTENT_REJECTED'}}}), /safe educational/u);
});
