import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {SignJWT} from 'jose';
import {loadConfig} from '../src/config.js';
import {createMongoRepository} from '../src/repository.js';
import {signAccessToken, validCsrfToken, verifyAccessToken} from '../src/security.js';

const config = loadConfig({NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/avs_phase3_test_only', JWT_SECRET: 'a'.repeat(64), CSRF_SECRET: 'b'.repeat(64)});
const userId = 'a'.repeat(24), sessionId = 'b'.repeat(24);

test('JWT verifier requires the selected algorithm, issuer, audience, type and exact lifetime', async () => {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const good = await signAccessToken(userId, sessionId, config, now);
  assert.deepEqual(await verifyAccessToken(good, config, now), {userId, sessionId});
  assert.equal(await verifyAccessToken(good, config, now + 901000), null);
  const variants = [
    {issuer: 'another-api'},
    {audience: 'another-client'},
    {type: 'NOT_A_JWT'},
    {algorithm: 'HS384'},
    {expiry: seconds + 3600},
    {issued: seconds + 2, expiry: seconds + 902},
    {subject: 'not-an-internal-id'},
    {sid: '../session'},
    {secret: 'c'.repeat(64)},
    {omitExpiry: true},
  ];
  for (const variant of variants) {
    let signer = new SignJWT({sid: variant.sid || sessionId}).setProtectedHeader({alg: variant.algorithm || 'HS256', typ: variant.type || 'JWT'}).setIssuer(variant.issuer || config.jwtIssuer).setAudience(variant.audience || config.jwtAudience).setSubject(variant.subject || userId).setIssuedAt(variant.issued || seconds);
    if (!variant.omitExpiry) signer = signer.setExpirationTime(variant.expiry || seconds + 900);
    const token = await signer.sign(new TextEncoder().encode(variant.secret || config.jwtSecret));
    assert.equal(await verifyAccessToken(token, config, now), null, JSON.stringify(variant));
  }
  assert.equal(await verifyAccessToken('eyJhbGciOiJub25lIn0.e30.', config, now), null);
  assert.equal(await verifyAccessToken('x'.repeat(3000), config, now), null);
});

test('unsigned or malformed CSRF bindings cannot be used as mutation credentials', () => {
  for (const value of [null, {}, 'x'.repeat(3000), 'unsigned', 'a'.repeat(43) + '.' + Date.now() + '.' + 'b'.repeat(43)]) assert.equal(validCsrfToken(value, config), false);
});

test('Mongo models enforce unique email/hash indexes, explicit TTL, private hashes and codepoint names', async () => {
  const connection = mongoose.createConnection();
  const repository = createMongoRepository(connection);
  const {User, Session} = repository.models;
  const userIndexes = User.schema.indexes();
  assert.ok(userIndexes.some(([fields, options]) => fields.emailNormalized === 1 && options.unique));
  assert.equal(User.schema.path('passwordHash').options.select, false);
  assert.equal(Session.schema.path('tokenHash').options.select, false);
  assert.equal(Session.schema.path('usedTokenHashes').options.select, false);
  const indexes = Session.schema.indexes();
  assert.ok(indexes.some(([fields, options]) => fields.tokenHash === 1 && options.unique));
  assert.ok(indexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
  const fields = {emailNormalized: 'DEMO@example.test', passwordHash: 'test-only-hash'};
  await assert.rejects(new User({...fields, displayName: 'a'.repeat(81)}).validate());
  await assert.rejects(new User({...fields, displayName: '🔑'}).validate());
  const valid = new User({...fields, displayName: '🔑'.repeat(80)});
  await valid.validate();
  assert.equal(valid.emailNormalized, 'demo@example.test');
  assert.equal(valid.role, 'USER');
  assert.equal(valid.status, 'ACTIVE');
  await connection.close();
});
