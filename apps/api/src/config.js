import path from 'node:path';
import {fileURLToPath} from 'node:url';

const bytes = value => Buffer.byteLength(value || '', 'utf8');
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const integer = (value, fallback, min, max, name) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name} configuration.`);
  return parsed;
};
const boolean = (value, fallback, name) => {
  if (value === undefined || value === '') return fallback;
  if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name} configuration.`);
  return value === 'true';
};

export function loadConfig(environment = process.env) {
  const isProduction = environment.NODE_ENV === 'production';
  const appOriginInput = environment.APP_ORIGIN || 'http://127.0.0.1:5173';
  let appUrl;
  try { appUrl = new URL(appOriginInput); } catch { throw new Error('APP_ORIGIN must be an absolute origin.'); }
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/') throw new Error('APP_ORIGIN must contain only the frontend scheme, host and port.');
  if (isProduction && appUrl.protocol !== 'https:') throw new Error('Production APP_ORIGIN requires HTTPS.');
  if (!isProduction && appUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname)) throw new Error('Plain HTTP is allowed only for local development.');
  if (!environment.MONGODB_URI || !/^mongodb(?:\+srv)?:\/\//u.test(environment.MONGODB_URI)) throw new Error('MONGODB_URI must select a MongoDB database.');
  if (bytes(environment.JWT_SECRET) < 32 || bytes(environment.CSRF_SECRET) < 32 || environment.JWT_SECRET === environment.CSRF_SECRET) throw new Error('Configure distinct JWT_SECRET and CSRF_SECRET values with at least 32 bytes each.');
  const apiPort = Number(environment.API_PORT || 4100);
  if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('API_PORT must be between 1 and 65535.');
  const apiHost = environment.API_HOST || '127.0.0.1';
  const trustProxyInput = environment.TRUST_PROXY || 'none';
  if (!['none', 'loopback'].includes(trustProxyInput) || trustProxyInput === 'loopback' && !['127.0.0.1', '::1'].includes(apiHost)) throw new Error('Select no proxy or a trusted loopback proxy with a loopback-only API listener.');
  const enforceHttps = boolean(environment.ENFORCE_HTTPS, isProduction, 'HTTPS enforcement');
  if (enforceHttps && appUrl.protocol !== 'https:') throw new Error('HTTPS enforcement requires an HTTPS APP_ORIGIN.');
  const mailMode = environment.MAIL_TRANSPORT || (environment.NODE_ENV === 'development' ? 'local' : 'disabled');
  if (!['local', 'resend', 'disabled'].includes(mailMode) || (isProduction && mailMode === 'local')) throw new Error('Select a supported production email transport. Local previews are development-only.');
  const mailFrom = environment.MAIL_FROM || 'AI Video Studio <no-reply@localhost.invalid>';
  if (/[\r\n\x00-\x1f\x7f]/u.test(mailFrom) || mailFrom.length > 340 || !/^[^<>]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/u.test(mailFrom)) throw new Error('Configure a valid MAIL_FROM address.');
  if (mailMode === 'resend' && (!environment.RESEND_API_KEY || /[\r\n\x00-\x1f\x7f]/u.test(environment.RESEND_API_KEY) || !environment.MAIL_FROM)) throw new Error('Configure the email provider credential and verified sender.');
  if (environment.MAIL_ENCRYPTION_SECRET && (bytes(environment.MAIL_ENCRYPTION_SECRET) < 32 || [environment.JWT_SECRET, environment.CSRF_SECRET].includes(environment.MAIL_ENCRYPTION_SECRET))) throw new Error('MAIL_ENCRYPTION_SECRET requires an independent secret of at least 32 bytes.');
  return Object.freeze({
    isProduction,
    appOrigin: appUrl.origin,
    apiHost,
    apiPort,
    trustProxy: trustProxyInput === 'loopback' ? 'loopback' : false,
    enforceHttps,
    requestLogging: boolean(environment.REQUEST_LOGGING, isProduction, 'request logging'),
    mongoUri: environment.MONGODB_URI,
    jwtSecret: environment.JWT_SECRET,
    csrfSecret: environment.CSRF_SECRET,
    mailMode,
    mailFrom,
    resendApiKey: environment.RESEND_API_KEY || '',
    mailEncryptionSecret: environment.MAIL_ENCRYPTION_SECRET || '',
    mailPreviewRoot: path.resolve(environment.MAIL_PREVIEW_ROOT || path.join(repositoryRoot, 'var/mail')),
    mailTimeoutMs: 10000,
    mailLeaseMs: 30000,
    mailMaxAttempts: 3,
    mailPollMs: 1000,
    accountActionRateLimit: 10,
    accountTokenRateLimit: 30,
    actionResendSeconds: 60,
    recoveryResponseFloorMs: 250,
    verifyEmailLifetimeSeconds: 86400,
    recoveryLifetimeSeconds: 1800,
    geminiApiKey: environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY || '',
    geminiModel: environment.GEMINI_MODEL || 'gemini-2.5-flash',
    geminiTimeoutMs: integer(environment.GEMINI_TIMEOUT_MS, 45000, 1000, 90000, 'Gemini timeout'),
    planningMaxAttempts: 2,
    assistantTimeoutMs: Math.min(45000, integer(environment.GEMINI_TIMEOUT_MS, 45000, 1000, 90000, 'Gemini timeout')),
    assistantDailyLimit: integer(environment.ASSISTANT_DAILY_LIMIT, 30, 0, 1000, 'daily assistant allowance'),
    assistantMaxMessages: 200,
    assistantContextMessages: 12,
    assistantContextChars: 16000,
    assistantRateLimit: 10,
    assistantMaxConcurrent: 2,
    reportDailyLimit: integer(environment.REPORT_DAILY_LIMIT, 10, 0, 100, 'daily report allowance'),
    assistantLeaseMs: 120000,
    dailyGenerationLimit: integer(environment.DAILY_GENERATION_LIMIT, 3, 0, 1000, 'daily allowance'),
    repositoryRoot,
    storageRoot: path.resolve(environment.PRIVATE_STORAGE_ROOT || path.join(repositoryRoot, 'var/media')),
    workerWorkRoot: path.resolve(environment.WORKER_WORK_ROOT || path.join(repositoryRoot, 'var/jobs')),
    engineRoot: path.join(repositoryRoot, 'packages/video-engine'),
    browserExecutable: environment.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    kokoroModelPath: environment.KOKORO_MODEL_PATH || undefined,
    workerHeartbeatMs: 10000,
    workerLeaseMs: 60000,
    workerPollMs: 1000,
    workerOfflineMs: 30000,
    maxExecutionAttempts: 2,
    maxQueuedJobs: 2,
    powershellExecutable: environment.POWERSHELL_EXECUTABLE || 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe',
    workerStageTimeoutMs: Object.freeze(Object.fromEntries([[30, 480000, 900000], [60, 900000, 1800000], [90, 1200000, 2700000]].map(([duration, render, speech]) => [duration, {PREPARE_ASSETS: 60000, SYNTHESIZE_AUDIO: speech, ALIGN_TIMELINE: 60000, RENDER_VIDEO: render, VALIDATE_OUTPUT: 120000, UPLOAD_OUTPUT: 60000}]))),
    jwtIssuer: 'ai-video-studio',
    jwtAudience: 'ai-video-studio-web',
    accessLifetimeSeconds: 900,
    refreshLifetimeSeconds: 604800,
    csrfLifetimeSeconds: 604800,
    maxSessionRotations: 2048,
    authRateLimit: 10,
    refreshRateLimit: 120,
    rateWindowMs: 15 * 60 * 1000,
  });
}
