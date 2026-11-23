import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {buildRenderProfile, parseRenderOrigin} from '../../ops/render/profile.mjs';
import {repositoryRoot} from '../../ops/production/profile.mjs';

const origin = 'https://studio-example.onrender.com';
const input = () => ({RENDER_EXTERNAL_URL: origin, MONGODB_URI: 'mongodb+srv://example:example@cluster.example.mongodb.net/ai_video_studio_render?retryWrites=true&w=majority', JWT_SECRET: 'j'.repeat(48), CSRF_SECRET: 'c'.repeat(48), MAIL_ENCRYPTION_SECRET: 'm'.repeat(48)});

test('Render profile uses one HTTPS Render origin and independent cloud configuration', () => {
  const profile = buildRenderProfile({...input(), PORT: '12000', API_HOST: '0.0.0.0', TRUST_PROXY: 'all', MAIL_TRANSPORT: 'local', RESEND_API_KEY: 'old-provider-value', PRIVATE_STORAGE_ROOT: 'var/demo/media'});
  assert.equal(profile.origin, origin); assert.equal(profile.port, 12000); assert.equal(profile.apiPort, 4300);
  assert.equal(profile.config.isProduction, true); assert.equal(profile.config.apiHost, '127.0.0.1'); assert.equal(profile.config.trustProxy, 'loopback'); assert.equal(profile.config.enforceHttps, true);
  assert.equal(profile.config.mailMode, 'disabled'); assert.equal(profile.environment.RESEND_API_KEY, '');
  assert.equal(profile.config.storageRoot, path.join(repositoryRoot, 'var/render/media')); assert.equal(profile.config.workerWorkRoot, path.join(repositoryRoot, 'var/render/jobs'));
  assert.equal(profile.config.geminiApiKey, ''); assert.equal(buildRenderProfile(input()).port, 10000);
  assert.equal(new URL(profile.config.mongoUri).searchParams.get('tls'), 'true');
  assert.ok(Object.isFrozen(profile.environment));
});

test('Render profile refuses unsafe origins, inconsistent public addresses and conflicting ports', () => {
  for (const value of ['http://studio-example.onrender.com', 'https://onrender.com', 'https://example.com', 'https://studio.onrender.com.evil.test', 'https://a.b.onrender.com', origin + '/login', origin + '?x=y', origin + '#x', origin + ':444', 'https://user:password@studio-example.onrender.com']) assert.throws(() => parseRenderOrigin(value), /RENDER_ORIGIN_INVALID/u);
  assert.throws(() => buildRenderProfile({...input(), APP_ORIGIN: 'https://different.onrender.com'}), /RENDER_ORIGIN_MISMATCH/u);
  for (const PORT of ['4300', '80', '65536', '1.2', 'not-a-port']) assert.throws(() => buildRenderProfile({...input(), PORT}), /RENDER_PORT_INVALID/u);
});

test('Render profile requires a dedicated Atlas database and three distinct provisioned secrets', () => {
  for (const uri of ['', 'mongodb://localhost:27018/ai_video_studio_phase3', 'mongodb+srv://example:example@evil.test/ai_video_studio_render', 'mongodb+srv://example:example@cluster.example.mongodb.net/', 'mongodb+srv://example:example@cluster.example.mongodb.net/admin', 'mongodb+srv://example:example@cluster.example.mongodb.net/ai_video_studio_demo', 'mongodb+srv://example:example@cluster.example.mongodb.net/ai_video_studio_production_local', 'mongodb+srv://cluster.example.mongodb.net/ai_video_studio_render']) assert.throws(() => buildRenderProfile({...input(), MONGODB_URI: uri}), /RENDER_ATLAS_DATABASE_REQUIRED/u);
  for (const override of [{JWT_SECRET: ''}, {CSRF_SECRET: 'j'.repeat(48)}, {MAIL_ENCRYPTION_SECRET: 'c'.repeat(48)}, {JWT_SECRET: 'REPLACE_'.repeat(8)}]) assert.throws(() => buildRenderProfile({...input(), ...override}), /RENDER_INDEPENDENT_SECRETS_REQUIRED/u);
  const source = input(); buildRenderProfile(source); assert.deepEqual(source, input(), 'Provisioned inputs are never rotated or modified');
});

test('Atlas transport cannot disable TLS or certificate/hostname validation through URI options', () => {
  const uri = input().MONGODB_URI;
  for (const option of ['tls=false', 'ssl=false', 'TLS=false', 'tlsAllowInvalidCertificates=true', 'tlsAllowInvalidHostnames=true', 'tlsInsecure=true', 'tlsCAFile=/tmp/custom.pem', 'tls=true&TLS=false', 'retryWrites=true']) assert.throws(() => buildRenderProfile({...input(), MONGODB_URI: uri + '&' + option}), /RENDER_ATLAS_TLS_CONFIGURATION_INVALID/u);
  const secure = buildRenderProfile({...input(), MONGODB_URI: uri + '&tls=true&ssl=true'});
  assert.equal(new URL(secure.config.mongoUri).searchParams.get('tls'), 'true');
});
