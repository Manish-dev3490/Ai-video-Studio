import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startRenderGateway} from '../../ops/render/gateway.mjs';

const origin = 'https://studio-example.onrender.com';
const request = (gateway, {path = '/', method = 'GET', headers = {}, body} = {}) => new Promise((resolve, reject) => {
  const req = http.request({hostname: '127.0.0.1', port: gateway.server.address().port, path, method, headers: {Host: new URL(origin).host, ...headers}}, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
  });
  req.once('error', reject); req.end(body);
});
async function fixture(handler) {
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startRenderGateway({port: 0, apiPort: upstream.address().port, origin, host: '127.0.0.1'});
  return {gateway, upstream, close: async () => {await gateway.close(); await new Promise(resolve => {upstream.close(resolve); upstream.closeAllConnections?.();});}};
}

test('Render gateway opens app routes without a gate and preserves real application401 responses', async () => {
  const f = await fixture((req, res) => {
    if (req.url === '/api/v1/auth/me') {res.writeHead(401, {'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="upstream"'}); res.end('{"error":{"code":"AUTH_REQUIRED"}}');}
    else res.end('<h1>Studio login</h1>');
  });
  try {
    const app = await request(f.gateway, {path: '/login', headers: {Accept: 'text/html'}});
    assert.equal(app.status, 200); assert.equal(app.headers.location, undefined); assert.equal(app.headers['set-cookie'], undefined); assert.equal(app.body, '<h1>Studio login</h1>');
    const auth = await request(f.gateway, {path: '/api/v1/auth/me'});
    assert.equal(auth.status, 401); assert.equal(auth.body, '{"error":{"code":"AUTH_REQUIRED"}}'); assert.equal(auth.headers['www-authenticate'], undefined);
  } finally {await f.close();}
});

test('Render readiness bypasses Host/protocol filtering only for exact read-only readiness requests', async () => {
  let calls = 0;
  const f = await fixture((req, res) => {calls++; assert.equal(req.headers.host, new URL(origin).host); res.writeHead(503, {'Content-Type': 'application/json'}); res.end('{"data":{"status":"not_ready"}}');});
  try {
    for (const method of ['GET', 'HEAD']) {
      const result = await request(f.gateway, {path: '/api/v1/ready', method, headers: {Host: '127.0.0.1:10000', 'X-Forwarded-Proto': 'http'}});
      assert.equal(result.status, 503); if (method === 'GET') assert.equal(JSON.parse(result.body).data.status, 'not_ready');
    }
    for (const item of [{path: '/api/v1/ready?x=y'}, {path: '/api/v1/health'}, {path: '/api/v1/ready', method: 'POST'}, {path: '/login'}]) assert.equal((await request(f.gateway, {...item, headers: {Host: 'evil.example'}})).status, 421);
    assert.equal((await request(f.gateway, {path: '/login', headers: {'X-Forwarded-Proto': 'http'}})).status, 426);
    assert.equal((await request(f.gateway, {path: '/login', headers: {'X-Forwarded-Proto': 'https,http'}})).status, 426);
    assert.equal(calls, 2);
  } finally {await f.close();}
});

test('Render proxy strips spoofed headers and old gate cookies while preserving app session, Origin and video ranges', async () => {
  const seen = [];
  const f = await fixture((req, res) => {
    seen.push(req.headers);
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      res.setHeader('Set-Cookie', ['avs_access=opaque; Secure; HttpOnly; SameSite=Lax', '__Host-avs_demo=old; Secure; HttpOnly']);
      res.setHeader('Connection', 'keep-alive, X-Internal'); res.setHeader('X-Internal', 'private');
      if (req.headers.range) {res.writeHead(206, {'Content-Range': 'bytes 0-3/12', 'Accept-Ranges': 'bytes'}); res.end('vide');}
      else res.end(Buffer.concat(chunks));
    });
  });
  try {
    const result = await request(f.gateway, {path: '/api/v1/projects', method: 'POST', body: '{"title":"example"}', headers: {Cookie: '__Host-avs_demo=old; avs_access=opaque', Authorization: 'Basic unused', 'Proxy-Authorization': 'unused', Forwarded: 'host=evil.test', 'X-Forwarded-For': '8.8.8.8, 203.0.113.9', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.test', 'X-Real-IP': '8.8.8.8', 'CF-Connecting-IP': '8.8.8.8', Origin: 'https://foreign.example', 'Content-Type': 'application/json'}});
    assert.equal(result.status, 200); assert.equal(result.body, '{"title":"example"}');
    assert.equal(seen[0].host, new URL(origin).host); assert.equal(seen[0]['x-forwarded-host'], new URL(origin).host); assert.equal(seen[0]['x-forwarded-proto'], 'https'); assert.equal(seen[0]['x-forwarded-for'], '203.0.113.9'); assert.equal(seen[0].origin, 'https://foreign.example'); assert.equal(seen[0].cookie, 'avs_access=opaque');
    for (const header of ['authorization', 'proxy-authorization', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) assert.equal(seen[0][header], undefined);
    assert.equal(result.headers['set-cookie'].length, 1); assert.equal(result.headers['x-internal'], undefined);
    const video = await request(f.gateway, {path: '/api/v1/media/example', headers: {Range: 'bytes=0-3', 'X-Forwarded-For': '203.0.113.9, invalid'}});
    assert.equal(video.status, 206); assert.equal(video.body, 'vide'); assert.equal(video.headers['content-range'], 'bytes 0-3/12'); assert.equal(seen[1]['x-forwarded-for'], '127.0.0.1');
  } finally {await f.close();}
});

test('Render gateway denies encoded private paths and malformed targets before forwarding', async () => {
  let calls = 0; const f = await fixture((req, res) => {calls++; res.end('upstream');});
  try {
    for (const path of ['/.env', '/var/render/private', '/DoCs/spec.md', '/.git/config', '/packages/video-engine', '/apps/api/src/config.js', '/node_modules/package', '/package-lock.json', '/render.yaml', '/%252eenv', '/app/../.env', '/app%5c..%5cops/private', '/.env::$DATA', '/VAR./private']) assert.equal((await request(f.gateway, {path})).status, 404, path);
    for (const path of ['http://evil.test/', '//evil.test/', '/bad\\path', '/bad%00path', '/bad%zzpath']) assert.equal((await request(f.gateway, {path})).status, 400, path);
    assert.equal((await request(f.gateway, {method: 'TRACE'})).status, 405); assert.equal(calls, 0);
  } finally {await f.close();}
});

test('Render gateway relays upstream API errors with their true status and sanitized connection failures', async () => {
  let status = 502;
  const body = '{"error":{"code":"AI_INVALID_OUTPUT"}}';
  const f = await fixture((req, res) => {res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store'}); res.end(body);});
  try {
    for (const value of [429, 502, 503, 504]) {
      status = value; const response = await request(f.gateway, {path: '/api/v1/projects'});
      assert.equal(response.status, value); assert.equal(response.body, body); assert.equal(response.headers['x-avs-origin-status'], undefined);
    }
    await new Promise(resolve => {f.upstream.close(resolve); f.upstream.closeAllConnections?.();});
    const outage = await request(f.gateway); assert.equal(outage.status, 502); assert.equal(outage.body, 'The studio is temporarily unavailable.'); assert.ok(!outage.body.includes('ECONNREFUSED'));
  } finally {await f.gateway.close(); if (f.upstream.listening) await new Promise(resolve => f.upstream.close(resolve));}
});
