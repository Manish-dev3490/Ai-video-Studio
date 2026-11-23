import {createSessionTransport} from './session-transport.js';
import {codePoints, friendlyError} from './forms.js';

export const reportReasons = [
  ['SAFETY', 'Unsafe or prohibited content'],
  ['NON_CONSENSUAL', 'Missing permission or consent'],
  ['IMPERSONATION', 'Deceptive impersonation'],
  ['PRIVACY', 'Privacy or personal information'],
  ['OTHER', 'Another misuse concern'],
];
const targetKinds = ['projectId', 'assetId'];
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export function reportFormErrors({targetKind, targetId, reasonCode, description}) {
  const errors = {};
  if (!targetKinds.includes(targetKind) || typeof targetId !== 'string' || !/^[a-f0-9]{24}$/u.test(targetId.trim())) errors.targetId = 'Enter a 24-character project or asset ID.';
  if (!reportReasons.some(([code]) => code === reasonCode)) errors.reasonCode = 'Choose the concern that best describes this report.';
  if (typeof description !== 'string' || !description.isWellFormed() || !description.trim() || codePoints(description) > 2000 || controls.test(description)) errors.description = 'Describe the concern using 1–2,000 characters.';
  else {
    const shadow = description.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
    if (/AIza[A-Za-z0-9_-]{35}|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bre_[A-Za-z0-9_-]{20,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})|\b(?:AKIA|ASIA)[A-Z0-9]{16}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:api[_ -]?key|client[_ -]?secret|password|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{16,}/iu.test(shadow)) errors.description = 'Remove passwords, API keys, tokens and private credentials before sending.';
  }
  return errors;
}

export function reportPayload(fields) {
  if (Object.keys(reportFormErrors(fields)).length) throw new Error('Check the report fields before sending.');
  return {[fields.targetKind]: fields.targetId.trim(), reasonCode: fields.reasonCode, description: fields.description.trim()};
}

export function reportError(error) {
  const code = error?.data?.error?.code;
  if (code === 'SENSITIVE_INPUT') return 'Remove passwords, API keys, tokens and private credentials before sending.';
  if (['REPORT_LIMIT_REACHED', 'REPORT_DAILY_LIMIT_REACHED', 'REPORT_DAILY_LIMIT'].includes(code)) return 'Your report allowance is used for today. Please wait until the next UTC day.';
  if (error?.status === 429) return 'Too many reports were submitted. Please wait before sending another.';
  return friendlyError(error, 'Your report could not be submitted. Check the details and try again.');
}
export const reportOutcomeUncertain = error => ['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR'].includes(error?.status) || Number(error?.status) >= 500;

const privacyListeners = new Set();
const controllers = new Set();
let privacyVersion = 0;
export const reportPrivacyVersion = () => privacyVersion;
export function subscribeReportPrivacy(listener) {privacyListeners.add(listener); return () => privacyListeners.delete(listener);}
export function clearReportSessions() {
  privacyVersion++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  for (const listener of [...privacyListeners]) listener();
}

/** Private report descriptions stay outside Redux, URLs and persistent storage. */
export function createReportRequest({fetchImpl = globalThis.fetch, locks = globalThis.navigator?.locks} = {}) {
  const request = async input => {
    const args = typeof input === 'string' ? {url: input, method: 'GET'} : input;
    const headers = new Headers(args.headers); headers.set('Accept', 'application/json');
    if (args.body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      if (args.signal?.aborted) return {error: {status: 'PRIVACY_RESET'}};
      const timeout = AbortSignal.timeout(15000);
      const response = await fetchImpl('/api/v1' + args.url, {method: args.method || 'GET', credentials: 'include', headers, signal: args.signal ? AbortSignal.any([args.signal, timeout]) : timeout, ...(args.body !== undefined ? {body: JSON.stringify(args.body)} : {})});
      let payload; try {payload = await response.json();} catch {return {error: {status: 'PARSING_ERROR'}};}
      return response.ok ? {data: payload} : {error: {status: response.status, data: payload}};
    } catch (error) {return {error: {status: error.name === 'TimeoutError' ? 'TIMEOUT_ERROR' : 'FETCH_ERROR'}};}
  };
  const transport = createSessionTransport(request, {locks});
  return async (fields, {signal} = {}) => {
    const body = reportPayload(fields);
    const version = privacyVersion;
    const controller = new AbortController(); controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const result = await transport({url: '/reports', method: 'POST', body, signal: combined});
      if (version !== privacyVersion || combined.aborted) throw {status: 'PRIVACY_RESET'};
      if (result.error) throw result.error;
      const saved = result.data?.data;
      if (!saved || typeof saved.id !== 'string' || saved.status !== 'OPEN' || typeof saved.createdAt !== 'string') throw {status: 'PARSING_ERROR'};
      return {id: saved.id, status: saved.status, createdAt: saved.createdAt};
    } finally {controllers.delete(controller);}
  };
}
export const requestReport = createReportRequest();
