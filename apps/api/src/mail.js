import fs from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {ensureDirectoryUnder} from './jobs/files.js';

const failure = (code, retryable = false) => Object.assign(new Error('The private email could not be delivered.'), {code, retryable});
const key = config => createHmac('sha256', config.mailEncryptionSecret || config.jwtSecret).update('ai-video-studio/account-mail/aes256gcm/v1').digest();
const contextBytes = context => Buffer.from(JSON.stringify({version: 1, userId: String(context.userId), purpose: context.purpose, actionId: context.actionId ? String(context.actionId) : null, tokenHash: context.tokenHash || null, authVersion: context.authVersion}));
const validAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/u.test(value);
export const validMailProviderId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
async function boundedProviderJson(response) {
  if (Number(response.headers.get('content-length') || 0) > 65536 || !response.body) {await response.body?.cancel(); throw failure('EMAIL_PROVIDER_RESPONSE_INVALID', true);}
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) {await reader.cancel(); throw failure('EMAIL_PROVIDER_RESPONSE_INVALID', true);}
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {if (error.code === 'EMAIL_PROVIDER_RESPONSE_INVALID') throw error; throw failure('EMAIL_PROVIDER_RESPONSE_INVALID', true);}
  finally {reader.releaseLock();}
}

async function providerRead(config, path, {fetchImpl = globalThis.fetch, signal} = {}) {
  if (config.mailMode !== 'resend' || !config.resendApiKey) throw failure('EMAIL_UNAVAILABLE');
  const timeout = AbortSignal.timeout(config.mailTimeoutMs || 10000);
  try {
    const response = await fetchImpl('https://api.resend.com' + path, {method: 'GET', redirect: 'error', headers: {Authorization: `Bearer ${config.resendApiKey}`, Accept: 'application/json'}, signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
    if (!response.ok) {
      await response.body?.cancel();
      throw failure([401, 403].includes(response.status) ? 'EMAIL_STATUS_PERMISSION_DENIED' : response.status === 404 ? 'EMAIL_STATUS_UNAVAILABLE' : 'EMAIL_PROVIDER_BUSY');
    }
    return await boundedProviderJson(response);
  } catch (error) {if (error.code && /^EMAIL_/u.test(error.code)) throw error; throw failure('EMAIL_STATUS_UNAVAILABLE');}
}

/** Trusted terminal support only. No raw bodies, recipients or action links leave this adapter. */
export async function readEmailDeliveryStatus(config, providerMessageId, options = {}) {
  if (!validMailProviderId(providerMessageId)) throw failure('MAIL_PAYLOAD_INVALID');
  const value = await providerRead(config, '/emails/' + providerMessageId, options);
  if (!validMailProviderId(value.id) || value.id.toLowerCase() !== providerMessageId.toLowerCase()) throw failure('EMAIL_PROVIDER_RESPONSE_INVALID');
  const allowed = ['sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked', 'scheduled', 'canceled', 'failed', 'suppressed'];
  const event = allowed.includes(value.last_event) ? value.last_event : 'unknown';
  return {providerMessageId: value.id.toLowerCase(), lastEvent: event, providerDeliveryConfirmed: event === 'delivered', inboxConfirmed: false};
}

export async function readEmailDomainStatus(config, domainId, options = {}) {
  if (!validMailProviderId(domainId)) throw failure('MAIL_PAYLOAD_INVALID');
  const value = await providerRead(config, '/domains/' + domainId, options);
  if (!validMailProviderId(value.id) || value.id.toLowerCase() !== domainId.toLowerCase()) throw failure('EMAIL_PROVIDER_RESPONSE_INVALID');
  const allowed = ['not_started', 'pending', 'verified', 'failure', 'temporary_failure'];
  const sender = config.mailFrom?.match(/<([^<>]+)>\s*$/u)?.[1] || config.mailFrom;
  const senderDomain = validAddress(sender) ? sender.slice(sender.lastIndexOf('@') + 1).toLowerCase() : null;
  return {domainId: value.id.toLowerCase(), status: allowed.includes(value.status) ? value.status : 'unknown', verified: value.status === 'verified', sendingEnabled: value.capabilities?.sending === 'enabled', matchesConfiguredSender: typeof value.name === 'string' && value.name.toLowerCase() === senderDomain};
}
function validateMessage(value) {
  if (!value || !validAddress(value.to) || typeof value.subject !== 'string' || !value.subject || value.subject.length > 180 || /[\r\n\x00-\x1f\x7f]/u.test(value.subject) || typeof value.text !== 'string' || !value.text || value.text.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.text) || typeof value.from !== 'string' || !value.from || /[\r\n\x00-\x1f\x7f]/u.test(value.from)) throw failure('MAIL_PAYLOAD_INVALID');
  return value;
}

/** Tokens are hashed in action records; email bodies are encrypted at rest. */
export function encryptMail(payload, config, context) {
  const message = validateMessage({...payload, from: config.mailFrom});
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(config), iv);
  cipher.setAAD(contextBytes(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
  return {version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url')};
}

export function decryptMail(envelope, config, context) {
  try {
    if (envelope?.version !== 1 || envelope.algorithm !== 'AES-256-GCM' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 100000) throw new Error();
    const iv = Buffer.from(envelope.iv, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key(config), iv);
    decipher.setAAD(contextBytes(context));
    decipher.setAuthTag(tag);
    return validateMessage(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')));
  } catch {throw failure('MAIL_PAYLOAD_INVALID');}
}

async function previewDirectory(config) {
  const repository = await fs.realpath(config.repositoryRoot);
  const requested = path.resolve(config.mailPreviewRoot);
  const relative = path.relative(path.join(repository, 'var'), requested);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure('MAIL_PREVIEW_PATH_INVALID');
  return ensureDirectoryUnder(repository, requested);
}
export {previewDirectory as privateMailPreviewRoot};

export function createMailTransport(config, {fetchImpl = globalThis.fetch} = {}) {
  return async (input, {messageId, signal} = {}) => {
    const message = validateMessage(input);
    if (!/^[a-f0-9]{24}$/u.test(String(messageId))) throw failure('MAIL_PAYLOAD_INVALID');
    if (config.mailMode === 'local' && !config.isProduction) {
      const root = await previewDirectory(config);
      const file = path.join(root, String(messageId) + '.json');
      const content = JSON.stringify({messageId: String(messageId), ...message}, null, 2) + '\n';
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        try {await handle.writeFile(content); await handle.sync();} finally {await handle.close();}
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || path.relative(root, await fs.realpath(file)) !== path.basename(file) || await fs.readFile(file, 'utf8') !== content) throw failure('MAIL_PREVIEW_CONFLICT');
      }
      return {provider: 'LOCAL_PREVIEW'};
    }
    if (config.mailMode !== 'resend' || !config.resendApiKey) throw failure('EMAIL_UNAVAILABLE');
    const timeout = AbortSignal.timeout(config.mailTimeoutMs || 10000);
    let response;
    try {
      response = await fetchImpl('https://api.resend.com/emails', {method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: {Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'avs-account-' + messageId}, body: JSON.stringify({from: message.from, to: [message.to], subject: message.subject, text: message.text})});
      if (!response.ok) {
        const conflict = response.status === 409 ? await boundedProviderJson(response).catch(() => null) : null;
        if (!response.bodyUsed) await response.body?.cancel();
        const retryable = [429, 500, 502, 503, 504].includes(response.status) || conflict?.name === 'concurrent_idempotent_requests';
        throw failure(retryable ? 'EMAIL_PROVIDER_BUSY' : 'EMAIL_PROVIDER_REJECTED', retryable);
      }
      // Acceptance is not inbox delivery. Retain only the private provider ID;
      // never return provider bodies, recipients or capability links in logs.
      const receipt = await boundedProviderJson(response);
      if (!validMailProviderId(receipt.id)) throw failure('EMAIL_PROVIDER_RESPONSE_INVALID', true);
      return {provider: 'EMAIL', providerMessageId: receipt.id.toLowerCase(), deliveryStatus: 'ACCEPTED', inboxConfirmed: false};
    } catch (error) {
      if (error.code && /^EMAIL_/u.test(error.code)) throw error;
      throw failure('EMAIL_DELIVERY_FAILED', true);
    }
  };
}

const rowContext = row => ({userId: row.userId, purpose: row.purpose, actionId: row.actionId, tokenHash: row.tokenHash, authVersion: row.authVersion});
async function eligibleMessage(row, models, now) {
  if (new Date(row.expiresAt).getTime() <= now) return null;
  const user = await models.User.findOne({_id: row.userId, status: 'ACTIVE'}).lean();
  if (!user) return null;
  if (row.purpose === 'SECURITY_NOTICE') return {recipient: null};
  if ((user.authVersion || 0) !== row.authVersion) return null;
  const action = await models.ActionToken.findOne({_id: row.actionId, userId: row.userId, purpose: row.purpose, tokenHash: row.tokenHash, authVersion: row.authVersion, emailNormalized: user.emailNormalized, usedAt: null, expiresAt: {$gt: new Date(now)}}).lean();
  return action ? {recipient: row.purpose === 'CHANGE_EMAIL' ? action.targetEmailNormalized : action.emailNormalized} : null;
}

/** One bounded delivery per call. A lease/fence makes restart and retry safe. */
export async function dispatchMailOnce({models, config, sendMail = createMailTransport(config), now = Date.now}) {
  if (!['local', 'resend', 'smtp'].includes(config.mailMode)) return {delivered: false};
  const time = now(), maxAttempts = config.mailMaxAttempts || 3;
  const terminalFilter = {$or: [{status: {$in: ['QUEUED', 'SENDING']}, expiresAt: {$lte: new Date(time)}}, {status: 'SENDING', attempts: {$gte: maxAttempts}, leaseUntil: {$lte: new Date(time)}}]};
  const abandoned = await models.MailOutbox.find(terminalFilter).select('_id').limit(50).lean();
  if (abandoned.length) await models.MailOutbox.updateMany({...terminalFilter, _id: {$in: abandoned.map(row => row._id)}}, {$set: {status: 'FAILED', deliveryToken: null, leaseUntil: null, lastErrorCode: 'MAIL_DELIVERY_EXPIRED'}, $unset: {payload: 1}});
  const deliveryToken = randomUUID();
  const row = await models.MailOutbox.findOneAndUpdate({expiresAt: {$gt: new Date(time)}, attempts: {$lt: maxAttempts}, $or: [{status: 'QUEUED', nextAttemptAt: {$lte: new Date(time)}}, {status: 'SENDING', leaseUntil: {$lte: new Date(time)}}]}, {$set: {status: 'SENDING', deliveryToken, leaseUntil: new Date(time + (config.mailLeaseMs || 30000))}, $inc: {attempts: 1}}, {sort: {createdAt: 1}, returnDocument: 'after'}).lean();
  if (!row) return {delivered: false};
  const fence = {_id: row._id, status: 'SENDING', deliveryToken};
  try {
    const eligible = await eligibleMessage(row, models, now());
    if (!eligible) {await models.MailOutbox.updateOne(fence, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null, lastErrorCode: 'ACTION_NO_LONGER_VALID'}, $unset: {payload: 1}}); return {delivered: false, cancelled: true};}
    const message = decryptMail(row.payload, config, rowContext(row));
    if (eligible.recipient && message.to !== eligible.recipient) throw failure('MAIL_PAYLOAD_INVALID');
    // Recheck the claim and action immediately before side effects. An action
    // revoked after this point may arrive, but its link remains unusable.
    if (!await models.MailOutbox.exists({...fence, leaseUntil: {$gt: new Date(now() + (config.mailTimeoutMs || 10000) + 1000)}})) return {delivered: false};
    if (!await eligibleMessage(row, models, now())) {await models.MailOutbox.updateOne(fence, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null, lastErrorCode: 'ACTION_NO_LONGER_VALID'}, $unset: {payload: 1}}); return {delivered: false, cancelled: true};}
    const accepted = await sendMail(message, {messageId: String(row._id)});
    if (accepted?.providerMessageId !== undefined && !validMailProviderId(accepted.providerMessageId)) throw failure('EMAIL_PROVIDER_RESPONSE_INVALID', true);
    // SENT is the legacy terminal dispatch state: the provider accepted the
    // request, not proof of mailbox placement or a human opening the message.
    const receipt = await models.MailOutbox.updateOne(fence, {$set: {status: 'SENT', sentAt: new Date(now()), ...(accepted?.providerMessageId ? {providerMessageId: accepted.providerMessageId.toLowerCase(), providerAcceptedAt: new Date(now())} : {}), leaseUntil: null, deliveryToken: null, lastErrorCode: null}, $unset: {payload: 1}});
    return {delivered: receipt.modifiedCount === 1};
  } catch (error) {
    const retry = error.retryable === true && row.attempts < maxAttempts && new Date(row.expiresAt).getTime() > now() + 5000;
    await models.MailOutbox.updateOne(fence, {$set: {status: retry ? 'QUEUED' : 'FAILED', nextAttemptAt: new Date(now() + Math.min(60000, 5000 * 2 ** (row.attempts - 1))), leaseUntil: null, deliveryToken: null, lastErrorCode: /^[A-Z0-9_]{1,80}$/u.test(error.code || '') ? error.code : 'EMAIL_DELIVERY_FAILED'}, ...(!retry ? {$unset: {payload: 1}} : {})});
    return {delivered: false, retrying: retry};
  }
}

export function startMailDispatcher(options) {
  let stopped = false, pending;
  const tick = () => {
    if (stopped || pending) return;
    pending = dispatchMailOnce(options).catch(() => {}).finally(() => {pending = undefined;});
  };
  const timer = setInterval(tick, options.config.mailPollMs || 1000).unref();
  tick();
  return {async stop() {stopped = true; clearInterval(timer); if (pending) await pending;}};
}
