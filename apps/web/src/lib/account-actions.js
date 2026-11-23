import {createSessionTransport} from './session-transport.js';
import {codePoints, friendlyError} from './forms.js';

const allowedActions = new Set([
  '/auth/forgot-password', '/auth/reset-password', '/auth/verify-email',
  '/auth/confirm-email-change', '/auth/request-email-verification', '/account/email-change',
]);
const tokenShape = /^[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/u;

export function actionTokenFromFragment(hash = '') {
  const fields = new URLSearchParams(hash.replace(/^#/u, ''));
  const tokens = fields.getAll('token');
  return tokens.length === 1 && tokenShape.test(tokens[0]) ? tokens[0] : null;
}

export function scrubActionLocation(location, history) {
  const search = new URLSearchParams(location.search || '');
  search.delete('token');
  const query = search.toString();
  if (location.hash || query !== (location.search || '').replace(/^\?/u, '')) history.replaceState(history.state, '', location.pathname + (query ? '?' + query : ''));
}

/** An empty, already-scrubbed URL must not replace a captured in-memory link. */
export function captureActionLocation(location, history) {
  const present = Boolean(location.hash) || new URLSearchParams(location.search || '').has('token');
  if (!present) return {present: false, token: null};
  const token = actionTokenFromFragment(location.hash);
  scrubActionLocation(location, history);
  return {present: true, token};
}

export function profileNameError(value) {
  const name = value.trim().normalize('NFC');
  return !name.isWellFormed() || /[\x00-\x1F\x7F]/u.test(name) || codePoints(name) < 2 || codePoints(name) > 80 ? 'Use a name between 2 and 80 characters.' : '';
}

export function emailAddressError(value) {
  const email = value.trim();
  return !email.isWellFormed() || email.length > 254 || !/^[^\s@<>\x00-\x1F\x7F]+@[^\s@<>\x00-\x1F\x7F]+\.[^\s@<>\x00-\x1F\x7F]+$/u.test(email) ? 'Enter a valid email address.' : '';
}

export function recoveryPasswordErrors(password, confirmation) {
  const errors = {};
  if (!password.isWellFormed() || codePoints(password) < 15 || codePoints(password) > 128) errors.password = 'Use 15–128 characters. Spaces and symbols are welcome.';
  if (confirmation !== password) errors.confirmation = 'The passwords do not match.';
  return errors;
}

export function accountError(error, fallback = 'Your account could not be updated. Please try again.') {
  const code = error?.data?.error?.code;
  if (code === 'INVALID_ACTION_LINK') return 'This link is invalid, expired or already used. Request a new link and try again.';
  if (['MAIL_UNAVAILABLE', 'EMAIL_DELIVERY_UNAVAILABLE'].includes(code) || (code === 'EMAIL_UNAVAILABLE' && Number(error.status) >= 500)) return 'Email delivery is unavailable right now. Please try again after the studio operator connects it.';
  if (code === 'EMAIL_CHANGE_UNAVAILABLE') return 'This email change could not be completed. Request a new confirmation link or choose a different address.';
  if (['INVALID_CREDENTIALS', 'CURRENT_PASSWORD_INCORRECT'].includes(code)) return 'Your current password was not accepted. Please try again.';
  if (code === 'RATE_LIMITED' || error?.status === 429) return 'Please wait before requesting another email. Your previous link may still be available.';
  return friendlyError(error, fallback);
}

/** Link tokens and current passwords stay out of Redux and its mutation cache. */
export function createAccountActionRequest({fetchImpl = globalThis.fetch, locks = globalThis.navigator?.locks} = {}) {
  const request = async input => {
    const args = typeof input === 'string' ? {url: input, method: 'GET'} : input;
    const headers = new Headers(args.headers);
    headers.set('Accept', 'application/json');
    if (args.body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      const response = await fetchImpl('/api/v1' + args.url, {
        method: args.method || 'GET', credentials: 'include', headers,
        ...(args.body !== undefined ? {body: JSON.stringify(args.body)} : {}),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let payload;
      try {payload = text ? JSON.parse(text) : null;}
      catch {return {error: {status: 'PARSING_ERROR'}};}
      return response.ok ? {data: payload} : {error: {status: response.status, data: payload, retryAfter: Math.min(3600, Math.max(1, Number(response.headers.get('Retry-After')) || 60))}};
    } catch (error) {
      return {error: {status: error.name === 'TimeoutError' ? 'TIMEOUT_ERROR' : 'FETCH_ERROR'}};
    }
  };
  const transport = createSessionTransport(request, {locks});
  return async (url, body = {}, method = 'POST') => {
    if (!allowedActions.has(url) || !['POST', 'DELETE'].includes(method) || (method === 'DELETE' && url !== '/account/email-change')) throw new Error('Unsupported account action.');
    const result = await transport({url, method, body});
    if (result.error) throw result.error;
    return result.data?.data;
  };
}

export const requestAccountAction = createAccountActionRequest();
