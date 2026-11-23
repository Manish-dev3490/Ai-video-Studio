import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assessLocalProfile, initializeLocalProfile, readProfile, profilePath, repositoryRoot, localMongoUri} from '../../ops/production/profile.mjs';
import {checkProductionProfile, parseCheckArguments} from '../production-check.mjs';
import {parseProductionArguments, productionChildEnvironment} from '../start-production.mjs';

const base = () => ({PRODUCTION_PROFILE: 'local', NODE_ENV: 'production', APP_ORIGIN: 'https://studio.localhost:8443', API_HOST: '127.0.0.1', API_PORT: '4200', TRUST_PROXY: 'loopback', ENFORCE_HTTPS: 'true', REQUEST_LOGGING: 'true', MONGODB_URI: localMongoUri, JWT_SECRET: 'a'.repeat(48), CSRF_SECRET: 'b'.repeat(48), MAIL_ENCRYPTION_SECRET: 'c'.repeat(48), MAIL_TRANSPORT: 'disabled', PRODUCTION_ALLOW_DISABLED_MAIL: 'true', PRIVATE_STORAGE_ROOT: 'var/production/media', WORKER_WORK_ROOT: 'var/production/jobs', LOCAL_TLS_CERT_FILE: 'var/production/tls/local-cert.pem', LOCAL_TLS_KEY_FILE: 'var/production/tls/local-key.pem'});

test('production children receive explicit profile values while the worker receives no mail or AI provider credentials', () => {
  const name = 'AVS_PHASE9_UNRELATED_PROCESS_SECRET', previous = process.env[name];
  process.env[name] = 'private-parent-only';
  try {
    const profile = {...base(), GEMINI_API_KEY: 'explicit-ai-key', GOOGLE_API_KEY: 'alternate-ai-key', RESEND_API_KEY: 'explicit-mail-key', MAIL_TRANSPORT: 'resend'};
    const api = productionChildEnvironment(profile), worker = productionChildEnvironment(profile, true);
    assert.equal(api.GEMINI_API_KEY, profile.GEMINI_API_KEY); assert.equal(api.RESEND_API_KEY, profile.RESEND_API_KEY); assert.equal(api[name], undefined);
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'RESEND_API_KEY', 'MAIL_ENCRYPTION_SECRET', name]) assert.equal(worker[key], undefined);
    assert.equal(worker.MAIL_TRANSPORT, 'disabled'); assert.equal(worker.MONGODB_URI, profile.MONGODB_URI);
  } finally {if (previous === undefined) delete process.env[name]; else process.env[name] = previous;}
});

test('local profile requires explicit TLS/proxy/mail isolation and never qualifies as a public launch', () => {
  assert.equal(assessLocalProfile(base()).passed, true);
  for (const patch of [{APP_ORIGIN: 'https://studio.example.com'}, {APP_ORIGIN: 'http://studio.localhost:8443'}, {API_HOST: '0.0.0.0'}, {TRUST_PROXY: 'none'}, {ENFORCE_HTTPS: 'false'}, {REQUEST_LOGGING: 'false'}, {PRODUCTION_ALLOW_DISABLED_MAIL: 'false'}, {API_PORT: '4100'}]) assert.equal(assessLocalProfile({...base(), ...patch}).passed, false);
  assert.equal(assessLocalProfile({...base(), APP_ORIGIN: 'https://evil.localhost.example.com'}).passed, false);
});

test('production paths and database stay separate from the working development prototype', () => {
  for (const patch of [{MONGODB_URI: 'mongodb://127.0.0.1:27018/ai_video_studio_phase3?replicaSet=avsLocal'}, {MONGODB_URI: 'mongodb://127.0.0.1:27018/%61i_video_studio_phase3'}, {MONGODB_URI: 'mongodb://127.0.0.1:27018/admin'}, {PRIVATE_STORAGE_ROOT: 'var/media'}, {WORKER_WORK_ROOT: 'var/jobs'}, {PRIVATE_STORAGE_ROOT: 'docs/media'}, {PRIVATE_STORAGE_ROOT: 'var/production/jobs/exports'}, {LOCAL_TLS_KEY_FILE: 'docs/key.pem'}]) assert.equal(assessLocalProfile({...base(), ...patch}).passed, false);
  assert.equal(assessLocalProfile({...base(), CSRF_SECRET: base().JWT_SECRET}).passed, false);
});

test('profile file selection refuses development env and approved or unignored source paths', () => {
  assert.throws(() => profilePath(path.join(repositoryRoot, '.env')), {code: 'PROFILE_FILE_OUTSIDE_IGNORED_WORKSPACE'});
  assert.throws(() => profilePath(path.join(repositoryRoot, 'docs', 'production.env')), {code: 'PROFILE_FILE_OUTSIDE_IGNORED_WORKSPACE'});
  assert.equal(profilePath(path.join(repositoryRoot, 'var/phase9-tests/example.env')), path.join(repositoryRoot, 'var/phase9-tests/example.env'));
});

test('private init generates distinct secrets once without overwriting development env or certificates', async () => {
  const allowed = path.join(repositoryRoot, 'var'), directory = path.join(allowed, 'phase9-ops-' + randomUUID());
  await fs.mkdir(directory, {recursive: true});
  const file = path.join(directory, 'production.env');
  const development = await fs.readFile(path.join(repositoryRoot, '.env'));
  let certificates = 0;
  try {
    const ensureCertificate = async () => {certificates++; return {certFile: path.join(directory, 'cert.pem'), keyFile: path.join(directory, 'key.pem')};};
    const first = await initializeLocalProfile({file, ensureCertificate}); assert.equal(first.created, true);
    const environment = await readProfile(file); assert.equal(assessLocalProfile(environment).passed, true);
    assert.equal(new Set(['JWT_SECRET', 'CSRF_SECRET', 'MAIL_ENCRYPTION_SECRET'].map(key => environment[key])).size, 3);
    assert.ok(environment.JWT_SECRET.length >= 64); assert.equal(environment.GEMINI_API_KEY, ''); assert.equal(environment.RESEND_API_KEY, '');
    const original = await fs.readFile(file);
    const second = await initializeLocalProfile({file, ensureCertificate}); assert.equal(second.created, false); assert.equal(certificates, 1); assert.deepEqual(await fs.readFile(file), original);
    assert.ok((await fs.readFile(path.join(repositoryRoot, '.env'))).equals(development), 'Development environment remains unchanged');
    const result = await checkProductionProfile({file}); assert.equal(result.passed, true); assert.equal(result.database.checked, false); assert.equal(result.native.checked, false); assert.equal(result.sendsEmail, false);
    assert.equal(JSON.stringify(result).includes(environment.JWT_SECRET), false);
    const publicCheck = await checkProductionProfile({file, publicLaunch: true}); assert.equal(publicCheck.passed, false); assert.ok(publicCheck.configuration.issues.includes('LOCAL_PROFILE_IS_NOT_A_PUBLIC_DEPLOYMENT'));
  } finally {assert.ok(directory.startsWith(allowed + path.sep)); await fs.rm(directory, {recursive: true, force: true});}
});

test('operational commands reject duplicate and unsupported switches', () => {
  assert.deepEqual(parseCheckArguments(['--native', '--database', '--env-file', 'var/example.env']), {native: true, database: true, file: 'var/example.env'});
  assert.throws(() => parseCheckArguments(['--native', '--native']));
  assert.throws(() => parseCheckArguments(['--send']));
  assert.deepEqual(parseProductionArguments(['--init']), {initialize: true});
  assert.throws(() => parseProductionArguments(['--init', '--init']));
});
