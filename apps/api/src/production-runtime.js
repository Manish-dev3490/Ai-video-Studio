import {performance} from 'node:perf_hooks';
import {ApiError} from './http.js';

const loopbackHost = value => ['127.0.0.1', '::1'].includes(value);
export function localProductionOrigin(value) {
  try {const url = new URL(value); return url.protocol === 'https:' && (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost'));}
  catch {return false;}
}

/** Deployment preflight only: no secrets or addresses enter returned issues. */
export function assessProductionRuntime(config, {allowDisabledMail = false} = {}) {
  const issues = [];
  if (!config.isProduction) issues.push('NODE_ENV_PRODUCTION_REQUIRED');
  try {if (new URL(config.appOrigin).protocol !== 'https:') issues.push('HTTPS_ORIGIN_REQUIRED');} catch {issues.push('HTTPS_ORIGIN_REQUIRED');}
  if (!loopbackHost(config.apiHost)) issues.push('LOOPBACK_API_REQUIRED');
  if (config.trustProxy !== 'loopback') issues.push('LOOPBACK_PROXY_REQUIRED');
  if (config.enforceHttps !== true) issues.push('HTTPS_ENFORCEMENT_REQUIRED');
  if (config.requestLogging !== true) issues.push('REQUEST_LOGGING_REQUIRED');
  if (typeof config.mailEncryptionSecret !== 'string' || Buffer.byteLength(config.mailEncryptionSecret) < 32 || [config.jwtSecret, config.csrfSecret].includes(config.mailEncryptionSecret)) issues.push('INDEPENDENT_MAIL_ENCRYPTION_SECRET_REQUIRED');
  const explicitlyDisabledLocal = allowDisabledMail && localProductionOrigin(config.appOrigin) && config.mailMode === 'disabled';
  if (!explicitlyDisabledLocal) {
    if (config.mailMode !== 'resend' || !config.resendApiKey) issues.push('REAL_EMAIL_CONFIGURATION_REQUIRED');
    if (typeof config.mailFrom !== 'string' || config.mailFrom.includes('localhost.invalid')) issues.push('REAL_EMAIL_SENDER_REQUIRED');
  }
  return {passed: issues.length === 0, issues};
}

const healthRequest = req => ['GET', 'HEAD'].includes(req.method) && ['/api/v1/health', '/api/v1/ready'].includes(req.path);
export function requireHttps(config) {
  return (req, res, next) => {
    if (config.enforceHttps !== true || req.secure || healthRequest(req)) return next();
    // Do not redirect a write, trust a client-supplied URL, or construct a link
    // using Host/Forwarded headers. The approved origin is a configuration value.
    return next(new ApiError(426, 'HTTPS_REQUIRED', 'Open the studio using its HTTPS address.'));
  };
}

/** Bounded and coalesced read-only probe. Worker availability is separate. */
export function createReadinessCheck({connection, timeoutMs = 1500, cacheMs = 2000, now = Date.now}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000 || !Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 10000) throw new Error('INVALID_READINESS_PROFILE');
  let last = false, expires = 0, pending;
  return async () => {
    if (connection?.readyState !== 1 || !connection.db) return false;
    if (now() < expires) return last;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      let timer;
      try {
        const deadline = new Promise(resolve => {timer = setTimeout(() => {controller.abort(); resolve(false);}, timeoutMs);});
        const command = Promise.resolve().then(() => connection.db.command({hello: 1, maxTimeMS: timeoutMs}, {signal: controller.signal, timeoutMS: timeoutMs})).then(hello => Boolean(hello?.isWritablePrimary === true && typeof hello.setName === 'string' && hello.setName.length > 0 && Number.isFinite(hello.logicalSessionTimeoutMinutes) && hello.logicalSessionTimeoutMinutes > 0)).catch(() => false);
        last = await Promise.race([command, deadline]);
      } catch {last = false;}
      finally {clearTimeout(timer); expires = now() + cacheMs; pending = null;}
      return last;
    })();
    return pending;
  };
}

/** Log only server-generated metadata; never URL parameters, query or payload. */
export function requestMetadataLogger({enabled = false, write = entry => process.stdout.write(JSON.stringify(entry) + '\n')} = {}) {
  return (req, res, next) => {
    if (!enabled) return next();
    const started = performance.now();
    res.once('finish', () => {
      const base = ['', '/api/v1', '/api/v1/auth', '/api/v1/account'].includes(req.baseUrl) ? req.baseUrl : '';
      const route = typeof req.route?.path === 'string' && req.route.path.length <= 200 ? base + req.route.path : 'unmatched';
      const entry = {event: 'HTTP_REQUEST', requestId: req.requestId, method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER', route, status: res.statusCode, durationMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100)};
      try {write(entry);} catch { /* A logging sink failure must not change a completed response. */ }
    });
    next();
  };
}
