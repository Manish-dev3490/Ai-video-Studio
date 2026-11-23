import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {loadConfig} from '../../apps/api/src/config.js';
import {assessProductionRuntime} from '../../apps/api/src/production-runtime.js';
import {ensureDirectoryUnder} from '../../apps/api/src/jobs/files.js';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultProfileFile = path.join(repositoryRoot, '.env.production.local');
export const localMongoUri = 'mongodb://127.0.0.1:27019/ai_video_studio_production_local?replicaSet=avsProductionLocal';
export const inside = (root, value) => {const relative = path.relative(root, value); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);};
const failure = code => Object.assign(new Error(code), {code});

export function profilePath(file = defaultProfileFile) {
  const resolved = path.resolve(file);
  if (resolved !== defaultProfileFile && !inside(path.join(repositoryRoot, 'var'), resolved)) throw failure('PROFILE_FILE_OUTSIDE_IGNORED_WORKSPACE');
  return resolved;
}

export function normalizedEnvironment(environment) {
  const value = {...environment};
  for (const name of ['PRIVATE_STORAGE_ROOT', 'WORKER_WORK_ROOT', 'MAIL_PREVIEW_ROOT', 'LOCAL_TLS_CERT_FILE', 'LOCAL_TLS_KEY_FILE']) if (value[name]) value[name] = path.resolve(repositoryRoot, value[name]);
  return value;
}

export async function readProfile(file = defaultProfileFile) {
  const resolved = profilePath(file), stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('PROFILE_FILE_INVALID');
  const real = await fs.realpath(resolved);
  if (path.relative(real, resolved) !== '') throw failure('PROFILE_FILE_INVALID');
  return normalizedEnvironment(parseEnv(await fs.readFile(real, 'utf8')));
}

export function assessLocalProfile(input) {
  const environment = normalizedEnvironment(input), issues = [];
  if (environment.PRODUCTION_PROFILE !== 'local' || environment.NODE_ENV !== 'production') issues.push('LOCAL_PRODUCTION_PROFILE_REQUIRED');
  let origin;
  try {origin = new URL(environment.APP_ORIGIN);} catch {issues.push('HTTPS_LOCAL_ORIGIN_REQUIRED');}
  if (origin && (origin.protocol !== 'https:' || !(origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost')) || !Number.isSafeInteger(Number(origin.port)) || Number(origin.port) < 1024 || Number(origin.port) > 65535 || origin.port === '5173')) issues.push('HTTPS_LOCAL_ORIGIN_REQUIRED');
  if (environment.API_HOST !== '127.0.0.1') issues.push('API_MUST_BIND_LOOPBACK');
  if (environment.TRUST_PROXY !== 'loopback' || environment.ENFORCE_HTTPS !== 'true') issues.push('TRUSTED_LOCAL_HTTPS_PROXY_REQUIRED');
  if (!Number.isSafeInteger(Number(environment.API_PORT)) || Number(environment.API_PORT) < 1024 || ['4100', '5173'].includes(environment.API_PORT) || origin && Number(environment.API_PORT) === Number(origin.port || 443)) issues.push('DEDICATED_PRODUCTION_PORT_REQUIRED');
  const disabledMailAllowed = environment.PRODUCTION_ALLOW_DISABLED_MAIL === 'true' && origin && (origin.hostname === 'localhost' || origin.hostname.endsWith('.localhost'));
  if (environment.MAIL_TRANSPORT !== 'resend' && !(environment.MAIL_TRANSPORT === 'disabled' && disabledMailAllowed)) issues.push('REAL_EMAIL_OR_EXPLICIT_LOCAL_DISABLED_MODE_REQUIRED');
  const secrets = ['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(name => environment[name]);
  if (secrets.some(value => typeof value !== 'string' || Buffer.byteLength(value) < 32 || /^(?:CHANGE|REPLACE|YOUR)[_-]/iu.test(value)) || new Set(secrets).size !== 3) issues.push('THREE_INDEPENDENT_SECRETS_REQUIRED');
  const varRoot = path.join(repositoryRoot, 'var');
  for (const name of ['PRIVATE_STORAGE_ROOT', 'WORKER_WORK_ROOT', 'LOCAL_TLS_CERT_FILE', 'LOCAL_TLS_KEY_FILE']) if (!environment[name] || !inside(varRoot, environment[name]) || environment[name] === varRoot) issues.push('PRIVATE_PRODUCTION_PATHS_REQUIRED');
  for (const name of ['PRIVATE_STORAGE_ROOT', 'WORKER_WORK_ROOT']) if ([path.join(varRoot, 'media'), path.join(varRoot, 'jobs'), path.join(varRoot, 'mail')].some(directory => environment[name] && inside(directory, environment[name]))) issues.push('DEVELOPMENT_DATA_PATH_NOT_ALLOWED');
  if (environment.PRIVATE_STORAGE_ROOT && environment.WORKER_WORK_ROOT && (inside(environment.PRIVATE_STORAGE_ROOT, environment.WORKER_WORK_ROOT) || inside(environment.WORKER_WORK_ROOT, environment.PRIVATE_STORAGE_ROOT))) issues.push('MEDIA_AND_JOB_ROOTS_MUST_BE_SEPARATE');
  try {
    const database = decodeURIComponent(new URL(environment.MONGODB_URI).pathname.slice(1));
    if (!database || database.includes('/') || ['admin', 'config', 'local', 'ai_video_studio_phase3'].includes(database.toLowerCase())) issues.push('ISOLATED_APPLICATION_DATABASE_REQUIRED');
  } catch {issues.push('ISOLATED_APPLICATION_DATABASE_REQUIRED');}
  let config;
  try {config = loadConfig(environment);} catch {issues.push('APPLICATION_CONFIGURATION_INVALID');}
  if (config) issues.push(...assessProductionRuntime(config, {allowDisabledMail: Boolean(disabledMailAllowed)}).issues);
  return {passed: issues.length === 0, issues: [...new Set(issues)], environment, config, origin, disabledMailAllowed: Boolean(disabledMailAllowed)};
}

export async function initializeLocalProfile({file = defaultProfileFile, ensureCertificate} = {}) {
  const destination = profilePath(file);
  try {await fs.lstat(destination); return {created: false, preservedExistingProfile: true};} catch (error) {if (error.code !== 'ENOENT') throw error;}
  await ensureDirectoryUnder(repositoryRoot, path.join(repositoryRoot, 'var', 'production', 'tls'));
  if (path.dirname(destination) !== repositoryRoot) await ensureDirectoryUnder(repositoryRoot, path.dirname(destination));
  const certificate = ensureCertificate || (await import('../../scripts/local-production-certificate.mjs')).ensureLocalCertificate;
  const credentials = await certificate({directory: path.join(repositoryRoot, 'var', 'production', 'tls'), hostname: 'studio.localhost', powershellExecutable: process.env.POWERSHELL_EXECUTABLE || 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'});
  if (!credentials?.certFile || !credentials.keyFile) throw failure('LOCAL_CERTIFICATE_NOT_AVAILABLE');
  const lines = [
    '# Private local production profile. Never commit this file.',
    'PRODUCTION_PROFILE=local', 'NODE_ENV=production', 'APP_ORIGIN=https://studio.localhost:8443', 'API_HOST=127.0.0.1', 'API_PORT=4200',
    'TRUST_PROXY=loopback', 'ENFORCE_HTTPS=true', 'REQUEST_LOGGING=true', `MONGODB_URI=${localMongoUri}`, 'AUTO_START_LOCAL_MONGO=true',
    ...['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(name => name + '=' + randomBytes(48).toString('base64url')),
    'MAIL_TRANSPORT=disabled', 'PRODUCTION_ALLOW_DISABLED_MAIL=true', 'MAIL_FROM=', 'RESEND_API_KEY=', 'GEMINI_API_KEY=', 'GEMINI_MODEL=gemini-2.5-flash',
    'DAILY_GENERATION_LIMIT=3', 'ASSISTANT_DAILY_LIMIT=30', 'REPORT_DAILY_LIMIT=10',
    'PRIVATE_STORAGE_ROOT=var/production/media', 'WORKER_WORK_ROOT=var/production/jobs', 'MAIL_PREVIEW_ROOT=var/production/mail-disabled',
    `LOCAL_TLS_CERT_FILE=${JSON.stringify(credentials.certFile)}`, `LOCAL_TLS_KEY_FILE=${JSON.stringify(credentials.keyFile)}`, '',
  ];
  try {await fs.writeFile(destination, lines.join('\n'), {flag: 'wx', mode: 0o600}); return {created: true, preservedDevelopmentEnvironment: true};}
  catch (error) {if (error.code === 'EEXIST') return {created: false, preservedExistingProfile: true}; throw error;}
}
