import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {ensureLocalCertificate, isLocalHostname, readLocalCertificate} from '../local-production-certificate.mjs';
import {startLocalGateway} from '../../ops/production/local-gateway.mjs';

let certificate;
const directory = path.resolve('var/phase9-tests/gateway-' + randomUUID());
before(async () => {certificate = await ensureLocalCertificate({directory, hostname: 'studio.localhost'});});
const port = () => new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const request = (port, headers = {}, verify = false) => new Promise((resolve, reject) => {
  const req = https.get({hostname: '127.0.0.1', port, servername: 'studio.localhost', rejectUnauthorized: verify, headers: {Host: `studio.localhost:${port}`, ...headers}}, response => {let text = ''; response.setEncoding('utf8'); response.on('data', value => {text += value;}); response.on('end', () => resolve({status: response.statusCode, headers: response.headers, text}));}); req.once('error', reject);
});

test('local certificate accepts only local DNS names and preserves an existing matching pair', async () => {
  assert.equal(isLocalHostname('studio.localhost'), true);
  for (const name of ['example.com', 'localhost.example.com', '*.localhost', 'localhost\n.test']) assert.equal(isLocalHostname(name), false);
  const first = await fs.readFile(certificate.keyFile);
  assert.equal((await ensureLocalCertificate({directory, hostname: 'studio.localhost'})).created, false);
  assert.ok((await fs.readFile(certificate.keyFile)).equals(first), 'Existing private key remains unchanged');
  await assert.rejects(readLocalCertificate({...certificate, hostname: 'other.localhost'}), {code: 'LOCAL_TLS_PAIR_INVALID'});
  await assert.rejects(readLocalCertificate({certFile: certificate.certFile, keyFile: certificate.certFile, hostname: 'studio.localhost'}), {code: 'LOCAL_TLS_PAIR_INVALID'});
  await assert.rejects(ensureLocalCertificate({directory: path.resolve('docs'), hostname: 'studio.localhost'}), {code: 'LOCAL_TLS_OPTIONS_INVALID'});
  const missing = path.join(directory, 'must-not-be-created');
  await assert.rejects(readLocalCertificate({certFile: path.join(missing, 'cert.pem'), keyFile: path.join(missing, 'key.pem'), hostname: 'studio.localhost'}));
  await assert.rejects(fs.stat(missing), {code: 'ENOENT'});
});

test('local HTTPS proxy replaces spoofed forwarding headers and rejects an unexpected Host', async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {calls++; res.setHeader('Set-Cookie', 'local-test=opaque; Secure; HttpOnly; SameSite=Lax'); res.end(JSON.stringify({host: req.headers.host, proto: req.headers['x-forwarded-proto'], client: req.headers['x-forwarded-for'], forwarded: req.headers.forwarded ?? null}));});
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const tlsPort = await port();
  const proxy = await startLocalGateway({origin: `https://studio.localhost:${tlsPort}`, apiPort: upstream.address().port, ...certificate});
  try {
    assert.equal(proxy.address().address, '127.0.0.1');
    const result = await request(tlsPort, {'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '8.8.8.8', Forwarded: 'proto=http;host=example.com'});
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), {host: `studio.localhost:${tlsPort}`, proto: 'https', client: '127.0.0.1', forwarded: null});
    assert.match(result.headers['set-cookie'][0], /Secure; HttpOnly/u);
    assert.equal((await request(tlsPort, {Host: 'foreign.example'})).status, 421); assert.equal(calls, 1);
    await assert.rejects(request(tlsPort, {}, true), error => /SELF_SIGNED|CERT/u.test(error.code));
    await assert.rejects(startLocalGateway({origin: 'https://example.com:8443', apiPort: upstream.address().port, ...certificate}), /LOCAL_GATEWAY_OPTIONS_INVALID/u);
  } finally {await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => upstream.close(resolve));}
});
