import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {demoRoot, demoMongoUri, publicDemoOrigin, assessDemoProfile} from '../../ops/demo/profile.mjs';
import {assessProductionRuntime} from '../../apps/api/src/production-runtime.js';

function profile() {return {DEMO_PROFILE: 'temporary', DEMO_ACKNOWLEDGE_NO_EMAIL: 'true', NODE_ENV: 'production', API_HOST: '127.0.0.1', API_PORT: '4300', MONGODB_URI: demoMongoUri, TRUST_PROXY: 'loopback', ENFORCE_HTTPS: 'true', REQUEST_LOGGING: 'true', MAIL_TRANSPORT: 'disabled', JWT_SECRET: 'j'.repeat(48), CSRF_SECRET: 'c'.repeat(48), MAIL_ENCRYPTION_SECRET: 'm'.repeat(48), DEMO_GATE_USER: 'demo', DEMO_GATE_PASSWORD: 'd'.repeat(32), PRIVATE_STORAGE_ROOT: path.join(demoRoot, 'media'), WORKER_WORK_ROOT: path.join(demoRoot, 'jobs'), MAIL_PREVIEW_ROOT: path.join(demoRoot, 'mail-disabled')};}
const origin = 'https://studio-test.trycloudflare.com';
test('temporary origins require one exact HTTPS Cloudflare hostname', () => {
  assert.equal(publicDemoOrigin(origin), origin);
  for (const value of ['http://studio-test.trycloudflare.com', 'https://trycloudflare.com', 'https://a.trycloudflare.com.evil.test', 'https://a.b.trycloudflare.com', origin + '/login', origin + '?x=y', 'https://a:b@studio-test.trycloudflare.com', origin + ':444']) assert.equal(publicDemoOrigin(value), null);
});
test('email-free temporary profile preserves strict real-production mail policy', () => {
  const result = assessDemoProfile(profile(), origin); assert.equal(result.passed, true); assert.equal(result.config.mailMode, 'disabled'); assert.equal(result.config.enforceHttps, true);
  const production = assessProductionRuntime(result.config, {allowDisabledMail: true}); assert.equal(production.passed, false); assert.ok(production.issues.includes('REAL_EMAIL_CONFIGURATION_REQUIRED'));
});
test('demo profile refuses reused secrets, development data, mail and weakened proxy settings', () => {
  for (const override of [{DEMO_ACKNOWLEDGE_NO_EMAIL: 'false'}, {API_HOST: '0.0.0.0'}, {API_PORT: '4100'}, {MONGODB_URI: 'mongodb://127.0.0.1:27018/ai_video_studio_phase3'}, {PRIVATE_STORAGE_ROOT: path.join(demoRoot, '..', 'media')}, {WORKER_WORK_ROOT: path.join(demoRoot, 'media')}, {ENFORCE_HTTPS: 'false'}, {TRUST_PROXY: 'none'}, {REQUEST_LOGGING: 'false'}, {MAIL_TRANSPORT: 'resend'}, {RESEND_API_KEY: 'not-an-actual-key'}, {DEMO_GATE_PASSWORD: 'short'}, {CSRF_SECRET: 'j'.repeat(48)}, {DEMO_GATE_PASSWORD: 'm'.repeat(48)}]) assert.equal(assessDemoProfile({...profile(), ...override}, origin).passed, false);
});
