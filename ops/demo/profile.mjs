import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseEnv} from 'node:util';
import {repositoryRoot, readProfile} from '../production/profile.mjs';
import {loadConfig} from '../../apps/api/src/config.js';
import {ensureDirectoryUnder} from '../../apps/api/src/jobs/files.js';

export const demoRoot = path.join(repositoryRoot, 'var/demo');
export const demoProfileFile = path.join(demoRoot, 'profile.env');
export const demoMongoUri = 'mongodb://127.0.0.1:27020/ai_video_studio_demo?replicaSet=avsDemoLocal';
export const tunnelFile = path.join(repositoryRoot, 'var/tools/cloudflared/2026.11.1/cloudflared.exe');
export const tunnelDigest = '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35';

export function publicDemoOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/u.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {return null;}
}

export async function initializeDemoProfile() {
  await ensureDirectoryUnder(repositoryRoot, demoRoot);
  try {await fs.lstat(demoProfileFile); return {created: false};} catch (error) {if (error.code !== 'ENOENT') throw error;}
  let existing = {};
  for (const file of ['.env.production.local', '.env']) {
    try {existing = parseEnv(await fs.readFile(path.join(repositoryRoot, file), 'utf8')); break;} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  const environment = {
    DEMO_PROFILE: 'temporary', DEMO_ACKNOWLEDGE_NO_EMAIL: 'true', NODE_ENV: 'production',
    API_HOST: '127.0.0.1', API_PORT: '4300', TRUST_PROXY: 'loopback', ENFORCE_HTTPS: 'true', REQUEST_LOGGING: 'true',
    MONGODB_URI: demoMongoUri,
    ...Object.fromEntries(['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(key => [key, randomBytes(48).toString('base64url')])),
    MAIL_TRANSPORT: 'disabled', MAIL_FROM: '', RESEND_API_KEY: '',
    GEMINI_API_KEY: existing.GEMINI_API_KEY || existing.GOOGLE_API_KEY || '', GEMINI_MODEL: existing.GEMINI_MODEL || 'gemini-2.5-flash',
    DAILY_GENERATION_LIMIT: '3', ASSISTANT_DAILY_LIMIT: '10', REPORT_DAILY_LIMIT: '5',
    PRIVATE_STORAGE_ROOT: path.join(demoRoot, 'media'), WORKER_WORK_ROOT: path.join(demoRoot, 'jobs'), MAIL_PREVIEW_ROOT: path.join(demoRoot, 'mail-disabled'),
    DEMO_GATE_USER: 'demo', DEMO_GATE_PASSWORD: randomBytes(24).toString('base64url'),
  };
  for (const name of ['BROWSER_EXECUTABLE', 'POWERSHELL_EXECUTABLE', 'KOKORO_MODEL_PATH', 'MONGOD_BINARY']) if (existing[name]) environment[name] = existing[name];
  try {await fs.writeFile(demoProfileFile, Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', {flag: 'wx', mode: 0o600});}
  catch (error) {if (error.code === 'EEXIST') return {created: false}; throw error;}
  return {created: true};
}

export async function readDemoProfile() {
  return readProfile(demoProfileFile);
}

/** An explicit temporary-demo policy; existing production/local policies remain untouched. */
export function assessDemoProfile(environment, origin) {
  const issues = [];
  if (environment.DEMO_PROFILE !== 'temporary' || environment.DEMO_ACKNOWLEDGE_NO_EMAIL !== 'true' || environment.NODE_ENV !== 'production') issues.push('EXPLICIT_TEMPORARY_DEMO_REQUIRED');
  if (!publicDemoOrigin(origin)) issues.push('EXACT_QUICK_TUNNEL_ORIGIN_REQUIRED');
  if (environment.API_HOST !== '127.0.0.1' || environment.API_PORT !== '4300' || environment.MONGODB_URI !== demoMongoUri) issues.push('DEDICATED_DEMO_SERVICES_REQUIRED');
  if (environment.TRUST_PROXY !== 'loopback' || environment.ENFORCE_HTTPS !== 'true' || environment.REQUEST_LOGGING !== 'true') issues.push('SECURE_PROXY_CONFIGURATION_REQUIRED');
  if (environment.MAIL_TRANSPORT !== 'disabled' || environment.RESEND_API_KEY || environment.MAIL_FROM) issues.push('DEMO_MAIL_MUST_BE_DISABLED');
  if (environment.DEMO_GATE_USER !== 'demo' || !/^[A-Za-z0-9_-]{32,}$/u.test(environment.DEMO_GATE_PASSWORD || '')) issues.push('INDEPENDENT_DEMO_ACCESS_REQUIRED');
  const secrets = ['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(key => environment[key]);
  if (secrets.some(value => typeof value !== 'string' || Buffer.byteLength(value) < 32) || new Set([...secrets, environment.DEMO_GATE_PASSWORD]).size !== 4) issues.push('INDEPENDENT_DEMO_SECRETS_REQUIRED');
  for (const [key, relative] of [['PRIVATE_STORAGE_ROOT', 'media'], ['WORKER_WORK_ROOT', 'jobs'], ['MAIL_PREVIEW_ROOT', 'mail-disabled']]) if (path.resolve(environment[key] || '.') !== path.join(demoRoot, relative)) issues.push('ISOLATED_DEMO_PATHS_REQUIRED');
  let config;
  try {config = loadConfig({...environment, APP_ORIGIN: origin});} catch {issues.push('APPLICATION_CONFIGURATION_INVALID');}
  return {passed: !issues.length, issues: [...new Set(issues)], config};
}
