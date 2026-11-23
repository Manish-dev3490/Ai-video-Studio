import path from 'node:path';
import {repositoryRoot} from '../production/profile.mjs';
import {loadConfig} from '../../apps/api/src/config.js';

export function parseRenderOrigin(value) {
  let url;
  try {url = new URL(value);} catch {throw new Error('RENDER_ORIGIN_INVALID');}
  if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/u.test(url.hostname)) throw new Error('RENDER_ORIGIN_INVALID');
  return url;
}

/** Cloud profile is separate from every existing laptop profile and database. */
export function buildRenderProfile(input = process.env) {
  const origin = parseRenderOrigin(input.APP_ORIGIN || input.RENDER_EXTERNAL_URL).origin;
  if (input.APP_ORIGIN && input.RENDER_EXTERNAL_URL && parseRenderOrigin(input.RENDER_EXTERNAL_URL).origin !== origin) throw new Error('RENDER_ORIGIN_MISMATCH');
  const port = Number(input.PORT || 10000), apiPort = 4300;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === apiPort) throw new Error('RENDER_PORT_INVALID');
  let mongo;
  try {mongo = new URL(input.MONGODB_URI);} catch {throw new Error('RENDER_ATLAS_DATABASE_REQUIRED');}
  const database = mongo.pathname.slice(1);
  if (mongo.protocol !== 'mongodb+srv:' || !mongo.hostname.endsWith('.mongodb.net') || !mongo.username || !mongo.password || mongo.port || mongo.hash || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(database) || ['admin', 'config', 'local', 'ai_video_studio_phase3', 'ai_video_studio_demo', 'ai_video_studio_production_local'].includes(database.toLowerCase()) || /[\r\n\x00-\x1f\x7f]/u.test(input.MONGODB_URI)) throw new Error('RENDER_ATLAS_DATABASE_REQUIRED');
  const allowedOptions = new Set(['retrywrites', 'w', 'appname', 'authsource', 'readpreference', 'replicaset', 'tls', 'ssl']);
  const seenOptions = new Set();
  for (const [key, value] of mongo.searchParams) {
    const normalized = key.toLowerCase();
    if (!allowedOptions.has(normalized) || seenOptions.has(normalized) || ['tls', 'ssl'].includes(normalized) && value !== 'true') throw new Error('RENDER_ATLAS_TLS_CONFIGURATION_INVALID');
    seenOptions.add(normalized);
  }
  // SRV enables TLS by default; keep it explicit and never permit certificate,
  // hostname or transport validation overrides in this hosted profile.
  if (!seenOptions.has('tls')) mongo.searchParams.set('tls', 'true');
  const secrets = ['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(name => input[name]);
  if (secrets.some(value => typeof value !== 'string' || Buffer.byteLength(value) < 32 || /[\r\n\x00-\x1f\x7f]/u.test(value) || /^(?:CHANGE|REPLACE|YOUR)[_-]/iu.test(value)) || new Set(secrets).size !== 3) throw new Error('RENDER_INDEPENDENT_SECRETS_REQUIRED');
  const environment = {
    NODE_ENV: 'production', APP_ORIGIN: origin, API_HOST: '127.0.0.1', API_PORT: String(apiPort),
    TRUST_PROXY: 'loopback', ENFORCE_HTTPS: 'true', REQUEST_LOGGING: 'true', MONGODB_URI: mongo.toString(),
    ...Object.fromEntries(['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(name => [name, input[name]])),
    MAIL_TRANSPORT: 'disabled', MAIL_FROM: '', RESEND_API_KEY: '',
    GEMINI_API_KEY: input.GEMINI_API_KEY || '', GEMINI_MODEL: input.GEMINI_MODEL || 'gemini-2.5-flash',
    DAILY_GENERATION_LIMIT: input.DAILY_GENERATION_LIMIT || '3', ASSISTANT_DAILY_LIMIT: input.ASSISTANT_DAILY_LIMIT || '10', REPORT_DAILY_LIMIT: input.REPORT_DAILY_LIMIT || '5',
    PRIVATE_STORAGE_ROOT: path.join(repositoryRoot, 'var/render/media'),
    WORKER_WORK_ROOT: path.join(repositoryRoot, 'var/render/jobs'),
    MAIL_PREVIEW_ROOT: path.join(repositoryRoot, 'var/render/mail-disabled'),
  };
  const config = loadConfig(environment);
  return {environment: Object.freeze(environment), config, origin, port, apiPort};
}
