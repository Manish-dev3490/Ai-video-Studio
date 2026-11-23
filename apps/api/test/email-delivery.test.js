import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailTransport, readEmailDeliveryStatus, readEmailDomainStatus} from '../src/mail.js';
import {parseEmailCheckArguments, runEmailCheck} from '../../../scripts/email-delivery-check.mjs';

const id = '37e4414c-5e25-4dbc-a071-43552a4bd53b';
const config = {mailMode: 'resend', mailFrom: 'Studio <no-reply@updates.example.com>', resendApiKey: 'private-provider-key-not-logged', appOrigin: 'https://studio.example.com', mailTimeoutMs: 1000, mailEncryptionSecret: 'independent-encryption-example'};
const message = {from: config.mailFrom, to: 'approved@example.com', subject: 'Private action', text: 'A private account action body must never be reflected by provider diagnostics.'};
const options = {messageId: 'a'.repeat(24)};

test('email CLI defaults to no network and requires explicit send plus a valid recipient', async () => {
  let calls = 0;
  assert.deepEqual(parseEmailCheckArguments([]), {mode: 'check'});
  const result = await runEmailCheck(config, {mode: 'check'}, {fetchImpl: async () => {calls++; assert.fail('No default network requests');}});
  assert.equal(result.networkRequests, 0); assert.equal(result.sent, false); assert.equal(result.productionDeliveryVerified, false); assert.equal(calls, 0);
  for (const args of [['--to', 'approved@example.com'], ['--send'], ['--send', '--to', 'bad'], ['--send', '--to', 'a@example.com\r\nBcc: b@example.com'], ['--send', '--to', 'a@example.com', '--status', id], ['--status', '../private'], ['--status', id, '--status', id], ['--domain-status', 'https://attacker.test']]) assert.throws(() => parseEmailCheckArguments(args), {code: 'INVALID_EMAIL_CHECK_ARGUMENTS'});
  assert.deepEqual(parseEmailCheckArguments(['--send', '--to', 'approved@example.com', '--request-id', options.messageId]), {mode: 'send', recipient: 'approved@example.com', requestId: options.messageId});
});

test('operator test email is opt-in, uses a stable reference, and never claims delivered or emits recipient/body', async () => {
  const calls = [];
  const result = await runEmailCheck(config, {mode: 'send', recipient: message.to, requestId: options.messageId}, {fetchImpl: async (url, request) => {calls.push({url, request}); return Response.json({id, private: message.text});}});
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.resend.com/emails'); assert.equal(calls[0].request.redirect, 'error');
  const payload = JSON.parse(calls[0].request.body); assert.deepEqual(payload.to, [message.to]); assert.ok(payload.text.includes(options.messageId)); assert.equal(payload.text.includes('#token='), false);
  assert.equal(result.providerAccepted, true); assert.equal(result.providerDeliveryConfirmed, false); assert.equal(result.inboxConfirmed, false);
  assert.equal(JSON.stringify(result).includes(message.to), false); assert.equal(JSON.stringify(result).includes(config.resendApiKey), false);
});

test('successful provider bodies must be bounded UUID receipts, with safe idempotent retry for an ambiguous acceptance', async () => {
  for (const response of [Response.json({id: 'not-an-email-id'}), new Response('not JSON'), new Response('x'.repeat(65537)), Response.json({id}, {headers: {'content-length': '70000'}})]) {
    const send = createMailTransport(config, {fetchImpl: async () => response});
    await assert.rejects(send(message, options), error => error.code === 'EMAIL_PROVIDER_RESPONSE_INVALID' && error.retryable === true && !error.message.includes(message.text));
  }
});

test('concurrent idempotent requests retry safely but conflicting payloads do not', async () => {
  for (const [name, retryable] of [['concurrent_idempotent_requests', true], ['invalid_idempotent_request', false]]) {
    const send = createMailTransport(config, {fetchImpl: async () => Response.json({name, message: 'Private provider diagnostic'}, {status: 409})});
    await assert.rejects(send(message, options), error => error.retryable === retryable && !error.message.includes('diagnostic'));
  }
});

test('read-only provider delivery reports are fixed-target, bounded and redact account content', async () => {
  let calls = 0;
  const result = await readEmailDeliveryStatus(config, id, {fetchImpl: async (url, request) => {
    calls++; assert.equal(url, 'https://api.resend.com/emails/' + id); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    return Response.json({id, last_event: 'delivered', to: [message.to], from: message.from, text: message.text, html: '<a>Private action</a>'});
  }});
  assert.deepEqual(result, {providerMessageId: id, lastEvent: 'delivered', providerDeliveryConfirmed: true, inboxConfirmed: false});
  assert.equal(calls, 1); assert.equal(JSON.stringify(result).includes('Private'), false);
  await assert.rejects(readEmailDeliveryStatus(config, '../secrets', {fetchImpl: async () => {assert.fail('No arbitrary path');}}), {code: 'MAIL_PAYLOAD_INVALID'});
  await assert.rejects(readEmailDeliveryStatus(config, id, {fetchImpl: async () => new Response('Private account detail', {status: 403})}), {code: 'EMAIL_STATUS_PERMISSION_DENIED'});
  await assert.rejects(readEmailDeliveryStatus(config, id, {fetchImpl: async () => Response.json({id: '00000000-0000-0000-0000-000000000000', last_event: 'delivered'})}), {code: 'EMAIL_PROVIDER_RESPONSE_INVALID'});
});

test('domain verification is read-only and must match the configured sender, without exposing DNS record values', async () => {
  const fetchImpl = async (url, request) => {assert.equal(url, 'https://api.resend.com/domains/' + id); assert.equal(request.method, 'GET'); return Response.json({id, name: 'updates.example.com', status: 'verified', capabilities: {sending: 'enabled'}, records: [{value: 'private diagnostic DNS value'}]});};
  assert.deepEqual(await readEmailDomainStatus(config, id, {fetchImpl}), {domainId: id, status: 'verified', verified: true, sendingEnabled: true, matchesConfiguredSender: true});
  const mismatch = await readEmailDomainStatus({...config, mailFrom: 'Other <sender@different.example.com>'}, id, {fetchImpl}); assert.equal(mismatch.matchesConfiguredSender, false);
});
