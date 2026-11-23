import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startDemoGateway, parseDemoOrigin} from '../../ops/demo/gateway.mjs';

const origin = 'https://quiet-video-demo.trycloudflare.com';
const username = 'demo';
const password = 'test-only-strong-demo-password-123';
const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
const request = (gateway, {path = '/', method = 'GET', headers = {}, body} = {}) => new Promise((resolve, reject) => {
  const req = http.request({host: '127.0.0.1', port: gateway.server.address().port, method, path, headers: {Host: new URL(origin).host, ...headers}}, res => {const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));});
  req.once('error', reject); req.end(body);
});
async function fixture(handler, options = {}) {
  const upstream = http.createServer(handler);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = await startDemoGateway({port: 0, apiPort: upstream.address().port, username, password, ...options});
  return {upstream, gateway, close: async () => {await gateway.close(); await new Promise(resolve => upstream.close(resolve));}};
}

async function login(gateway, fields = {}, headers = {}) {
  return request(gateway, {path: '/__demo/access', method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers}, body: new URLSearchParams({username, password, next: '/login', ...fields}).toString()});
}
async function cookie(gateway) {const response = await login(gateway); assert.equal(response.status, 303); assert.ok(response.headers['set-cookie']?.length === 1); return response.headers['set-cookie'][0].split(';')[0];}

test('temporary gateway locks HTTPS origin and serves no app during startup', async () => {
  let calls = 0; const f = await fixture((req, res) => {calls++; res.end('upstream');});
  try {
    assert.equal(f.gateway.server.address().address, '127.0.0.1'); assert.equal((await request(f.gateway)).status, 503);
    for (const value of ['http://demo.trycloudflare.com', 'https://example.com', 'https://trycloudflare.com', 'https://demo.trycloudflare.com.evil.example', 'https://demo.trycloudflare.com:8443', 'https://user:pass@demo.trycloudflare.com', 'https://demo.trycloudflare.com/path', 'https://demo.trycloudflare.com?x=1']) assert.throws(() => parseDemoOrigin(value), /DEMO_ORIGIN_INVALID/u);
    f.gateway.setOrigin(origin); f.gateway.setOrigin(origin); assert.throws(() => f.gateway.setOrigin('https://other-demo.trycloudflare.com'), /DEMO_ORIGIN_ALREADY_LOCKED/u);
    assert.equal((await request(f.gateway, {headers: {Host: 'evil.example'}})).status, 421); assert.equal(calls, 0);
  } finally {await f.close();}
});

test('public form replaces browser Basic challenges and redirects ordinary navigation', async () => {
  let calls = 0; const f = await fixture((req, res) => {calls++; res.end('app');});
  try {
    f.gateway.setOrigin(origin);
    const navigation = await request(f.gateway, {path: '/app/create', headers: {Accept: 'text/html,application/xhtml+xml'}});
    assert.equal(navigation.status, 303); assert.equal(navigation.headers.location, '/__demo/access?next=%2Fapp%2Fcreate');
    const form = await request(f.gateway, {path: '/__demo/access?next=%2Fapp%2Fcreate'});
    assert.equal(form.headers['referrer-policy'], 'same-origin', 'Browser form submissions retain a verifiable same-origin Origin');
    assert.equal(form.status, 200); assert.match(form.body, /Demo username/u); assert.match(form.body, /Demo password/u); assert.match(form.body, /Open demo/u); assert.ok(!form.body.includes(password)); assert.match(form.headers['content-security-policy'], /form-action 'self'/u); assert.equal(form.headers['cache-control'], 'no-store');
    for (const path of ['/', '/api/v1/health', '/api/v1/ready', '/api/v1/auth/csrf', '/assets/app.js', '/.env', '/var/demo/access.txt']) {
      const result = await request(f.gateway, {path, headers: {Authorization: authorization}});
      assert.equal(result.status, 403); assert.equal(result.headers['www-authenticate'], undefined); assert.equal(result.headers['cache-control'], 'no-store'); assert.ok(!result.body.includes(password));
    }
    assert.equal(calls, 0);
  } finally {await f.close();}
});

test('form issues a secure signed cookie; bad passwords and malformed/cross-origin forms stay outside app', async () => {
  let calls = 0; const f = await fixture((req, res) => {calls++; res.end('app');});
  try {
    f.gateway.setOrigin(origin);
    const wrong = await login(f.gateway, {password: 'incorrect'}); assert.equal(wrong.status, 403); assert.match(wrong.body, /incorrect/u); assert.equal(wrong.headers['set-cookie'], undefined); assert.equal(wrong.headers['www-authenticate'], undefined);
    assert.equal((await login(f.gateway, {}, {Origin: 'https://evil.example'})).status, 403);
    assert.equal((await login(f.gateway, {}, {Origin: ''})).status, 403);
    assert.equal((await login(f.gateway, {}, {'Content-Type': 'application/json'})).status, 415);
    for (const body of ['username=demo&username=other&password=bad', 'username=demo&password=bad&unexpected=yes']) assert.equal((await request(f.gateway, {path:'/__demo/access', method:'POST', headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'}, body})).status,400);
    const accepted = await login(f.gateway, {next: '/app/create'}); assert.equal(accepted.status, 303); assert.equal(accepted.headers.location, '/app/create');
    const setCookie = accepted.headers['set-cookie'][0]; assert.match(setCookie, /^__Host-avs_demo=/u); for (const flag of ['Secure','HttpOnly','Path=/','SameSite=Lax','Max-Age=28800']) assert.ok(setCookie.includes(flag)); assert.ok(!setCookie.includes(password));
    const app = await request(f.gateway, {headers: {Cookie:setCookie.split(';')[0]}}); assert.equal(app.status,200); assert.equal(calls,1);
    await assert.rejects(startDemoGateway({port:0,apiPort:f.upstream.address().port,username,password:'short'}), /DEMO_GATEWAY_OPTIONS_INVALID/u);
  } finally {await f.close();}
});

test('form return URLs cannot redirect externally or into private/reserved paths and attempts are bounded', async () => {
  const f = await fixture((req,res)=>res.end('app'));
  try {
    f.gateway.setOrigin(origin);
    for(const next of ['https://evil.example','//evil.example','/%2f%2fevil.example','/%5cevil.example','/.env','/__demo/access']) {const result=await login(f.gateway,{next});assert.equal(result.status,400);assert.equal(result.headers.location,undefined);}
    for(let i=0;i<4;i++)assert.equal((await login(f.gateway,{password:'bad'})).status,403);
    const limited=await login(f.gateway);assert.equal(limited.status,429);assert.match(limited.body,/Too many attempts/u);
  } finally {await f.close();}
});

test('forged, expired, duplicate and previous-process gate cookies never reach the API', async () => {
  let time=Date.now(),calls=0;const f=await fixture((req,res)=>{calls++;res.end('app');},{now:()=>time});const other=await fixture((req,res)=>res.end('other'));
  try {
    f.gateway.setOrigin(origin);other.gateway.setOrigin(origin);const valid=await cookie(f.gateway);
    assert.equal((await request(f.gateway,{headers:{Cookie:valid}})).status,200);
    const tampered=valid.slice(0,-1)+(valid.endsWith('a')?'b':'a');assert.equal((await request(f.gateway,{headers:{Cookie:tampered}})).status,403);
    assert.equal((await request(f.gateway,{headers:{Cookie:valid+'; '+valid}})).status,403);
    assert.equal((await request(other.gateway,{headers:{Cookie:valid}})).status,403);
    time+=28800*1000;assert.equal((await request(f.gateway,{headers:{Cookie:valid}})).status,403);assert.equal(calls,1);
  } finally {await f.close();await other.close();}
});

test('cookie survives normal application401 without challenge and stays separate from app cookies', async () => {
  const seen=[];const f=await fixture((req,res)=>{seen.push(req.headers);res.setHeader('WWW-Authenticate','Basic realm="upstream"');res.setHeader('Set-Cookie',['session=opaque; Secure; HttpOnly; SameSite=Lax','csrf=opaque; Secure; SameSite=Lax','__Host-avs_demo=malicious; Path=/']);res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":{"code":"AUTH_REQUIRED"}}');});
  try {
    f.gateway.setOrigin(origin);const gate=await cookie(f.gateway);const result=await request(f.gateway,{path:'/api/v1/auth/me',headers:{Cookie:gate+'; session=opaque',Authorization:authorization}});
    assert.equal(result.status,401);assert.equal(result.headers['www-authenticate'],undefined);assert.equal(result.headers['set-cookie'].length,2);assert.ok(result.headers['set-cookie'].every(value=>!value.startsWith('__Host-avs_demo=')));assert.equal(seen[0].cookie,'session=opaque');assert.equal(seen[0].authorization,undefined);
    assert.equal((await request(f.gateway,{path:'/api/v1/auth/me',headers:{Cookie:gate}})).status,401);assert.equal(seen.length,2);
    assert.equal((await request(f.gateway,{path:'/__demo/exit',method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
    const exit=await request(f.gateway,{path:'/__demo/exit',method:'POST',headers:{Origin:origin,Cookie:gate}});assert.equal(exit.status,303);assert.match(exit.headers['set-cookie'][0],/Max-Age=0/u);
  } finally {await f.close();}
});

test('demo forwarding strips spoofing, gate cookies and credentials, preserving app cookies and video ranges', async () => {
  const seen = [];
  const f = await fixture((req, res) => {seen.push(req.headers); const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {res.setHeader('Set-Cookie', ['session=opaque; Secure; HttpOnly; SameSite=Lax', 'csrf=opaque; Secure; SameSite=Lax']); res.setHeader('Content-Security-Policy', "default-src 'self'"); res.setHeader('Strict-Transport-Security', 'max-age=15552000'); res.setHeader('Connection', 'keep-alive, X-Upstream-Internal'); res.setHeader('X-Upstream-Internal', 'private'); if(req.headers.range){res.writeHead(206, {'Content-Range':'bytes 0-3/12', 'Accept-Ranges':'bytes'});res.end('vide');}else res.end(Buffer.concat(chunks).length ? Buffer.concat(chunks) : 'okay');});});
  try {
    f.gateway.setOrigin(origin);const gate=await cookie(f.gateway);
    const result = await request(f.gateway, {method:'POST', path:'/api/v1/projects?limit=2', body:'{"title":"demo"}', headers:{Authorization: authorization, 'Proxy-Authorization':'Basic should-not-forward', Cookie:gate+'; session=opaque', Origin:origin, 'Content-Type':'application/json', 'X-Forwarded-For':'attacker, 8.8.8.8', 'X-Forwarded-Proto':'http', 'X-Forwarded-Host':'evil.example', Forwarded:'host=evil.example;proto=http', 'X-Real-IP':'8.8.8.8', 'CF-Connecting-IP':'203.0.113.7', Connection:'keep-alive, X-Client-Internal', 'X-Client-Internal':'private'}});
    assert.equal(result.status, 200); assert.equal(result.body, '{"title":"demo"}');assert.equal(seen[0].host,new URL(origin).host);assert.equal(seen[0]['x-forwarded-proto'],'https');assert.equal(seen[0]['x-forwarded-for'],'203.0.113.7');assert.equal(seen[0].cookie,'session=opaque');assert.equal(seen[0].origin,origin);
    for(const key of ['authorization','proxy-authorization','forwarded','x-real-ip','cf-connecting-ip','x-client-internal'])assert.equal(seen[0][key],undefined);
    assert.equal(result.headers['set-cookie'].length,2);assert.equal(result.headers['content-security-policy'],"default-src 'self'");assert.equal(result.headers['x-upstream-internal'],undefined);
    const range=await request(f.gateway,{path:'/api/v1/media/video',headers:{Cookie:gate,Range:'bytes=0-3','CF-Connecting-IP':'spoofed, 8.8.8.8'}});assert.equal(range.status,206);assert.equal(range.body,'vide');assert.equal(range.headers['content-range'],'bytes 0-3/12');assert.equal(seen[1]['x-forwarded-for'],'127.0.0.1');
  } finally {await f.close();}
});

test('gateway rejects invalid targets and oversized forms and sanitizes upstream outages', async () => {
  let calls=0;const f=await fixture((req,res)=>{calls++;res.end('okay');});
  try {
    f.gateway.setOrigin(origin);const gate=await cookie(f.gateway);
    for(const path of ['http://evil.example/', '//evil.example/', '/bad\\path', '/bad%00path', '/bad%zzpath'])assert.equal((await request(f.gateway,{path,headers:{Cookie:gate}})).status,400);
    const large=await request(f.gateway,{path:'/__demo/access',method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:'x'.repeat(4100)});assert.equal(large.status,413);assert.equal(calls,0);
    await new Promise(resolve=>f.upstream.close(resolve));const unavailable=await request(f.gateway,{headers:{Cookie:gate}});assert.equal(unavailable.status,502);assert.equal(unavailable.body,'The demo application is unavailable.');assert.ok(!unavailable.body.includes('ECONNREFUSED'));
  } finally {await f.gateway.close();if(f.upstream.listening)await new Promise(resolve=>f.upstream.close(resolve));}
});

test('private paths require gate then deny decoded Windows/path bypasses while ordinary routes remain available', async () => {
  let calls=0;const f=await fixture((req,res)=>{calls++;res.end('public app route');});
  try {
    f.gateway.setOrigin(origin);const gate=await cookie(f.gateway);
    const privatePaths=['/.env','/.env.production.local','/.git','/.codex','/.agents','/.aws','/var','/docs','/review','/video-engine-poc','/packages','/ops','/scripts','/VAR/demo/access.txt','/DoCs/spec.md','/.ENV.production.local','/.%65nv','/%2e%65nv.production.local','/%252eenv','/app/../.env','/app/%2e%2e/VAR/private','/app%5c..%5cops/Caddyfile','/%5cvar%5cprivate','/%2fvar/private','/OPs./private','/.git%20/config','/.env::$DATA','/.env%3fignored','/app/..%20/.env'];
    for(const path of privatePaths){assert.equal((await request(f.gateway,{path})).status,403);const denied=await request(f.gateway,{path,headers:{Cookie:gate}});assert.equal(denied.status,404,'Private path denied');assert.equal(denied.headers['cache-control'],'no-store');}
    assert.equal(calls,0);for(const path of ['/app','/app/create','/assets/app.js','/api/v1/capabilities?next=/.env'])assert.equal((await request(f.gateway,{path,headers:{Cookie:gate}})).status,200);assert.equal(calls,4);
  } finally {await f.close();}
});

test('demo API edge preserves exact JSON502/504 error bytes as503 with original status metadata', async () => {
  let upstreamStatus = 502;
  const body = '{"error":{"code":"AI_INVALID_OUTPUT","message":"The script needs revision."},"meta":{"requestId":"test-request"}}\n';
  const f = await fixture((req, res) => {
    res.writeHead(upstreamStatus, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'public, max-age=600', 'Content-Security-Policy': "default-src 'self'", 'Strict-Transport-Security': 'max-age=15552000', 'WWW-Authenticate': 'Basic realm="upstream"', 'Set-Cookie': ['session=opaque; Secure; HttpOnly; SameSite=Lax', 'csrf=opaque; Secure; SameSite=Lax']});
    res.end(body);
  });
  try {
    f.gateway.setOrigin(origin); const gate = await cookie(f.gateway);
    for (const status of [502, 504]) {
      upstreamStatus = status;
      const result = await request(f.gateway, {path: '/api/v1/projects?check=1', headers: {Cookie: gate}});
      assert.equal(result.status, 503); assert.equal(result.headers['x-avs-origin-status'], String(status)); assert.equal(result.body, body);
      assert.equal(JSON.parse(result.body).error.code, 'AI_INVALID_OUTPUT'); assert.equal(result.headers['content-type'], 'application/json; charset=utf-8'); assert.equal(result.headers['content-length'], String(Buffer.byteLength(body)));
      assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['content-security-policy'], "default-src 'self'"); assert.equal(result.headers['strict-transport-security'], 'max-age=15552000'); assert.equal(result.headers['set-cookie'].length, 2); assert.equal(result.headers['www-authenticate'], undefined);
    }
  } finally {await f.close();}
});

test('demo edge leaves HTML, non-API and other JSON error statuses unchanged', async () => {
  let selected;
  const f = await fixture((req, res) => {res.writeHead(selected.status, {'Content-Type': selected.type, 'Cache-Control': 'private, max-age=0'}); res.end(selected.body);});
  try {
    f.gateway.setOrigin(origin); const gate = await cookie(f.gateway);
    for (const scenario of [
      {status: 502, type: 'text/html; charset=utf-8', path: '/api/v1/projects', body: '<h1>Unavailable</h1>'},
      {status: 502, type: 'application/json', path: '/app', body: '{"error":"static-route"}'},
      {status: 504, type: 'application/json', path: '/api/v2/projects', body: '{"error":"other-api"}'},
      {status: 503, type: 'application/json', path: '/api/v1/projects', body: '{"error":{"code":"AI_UNAVAILABLE"}}'},
      {status: 422, type: 'application/json', path: '/api/v1/projects', body: '{"error":{"code":"NARRATION_BUDGET"}}'},
    ]) {
      selected = scenario;
      const result = await request(f.gateway, {path: scenario.path, headers: {Cookie: gate}});
      assert.equal(result.status, scenario.status); assert.equal(result.body, scenario.body); assert.equal(result.headers['content-type'], scenario.type); assert.equal(result.headers['cache-control'], 'private, max-age=0'); assert.equal(result.headers['x-avs-origin-status'], undefined); assert.equal(result.headers['www-authenticate'], undefined);
    }
  } finally {await f.close();}
});

test('public demo opens normal app routes without an outer credential page or gate cookie', async () => {
  const seen = [];
  const f = await fixture((req, res) => {
    seen.push({url: req.url, headers: req.headers});
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>Studio sign in</h1>');
  }, {requireAccess: false});
  try {
    assert.equal((await request(f.gateway)).status, 503);
    f.gateway.setOrigin(origin);
    for (const route of ['/', '/login', '/signup', '/assets/app.js']) {
      const result = await request(f.gateway, {path: route, headers: {Accept: 'text/html'}});
      assert.equal(result.status, 200);
      assert.equal(result.headers.location, undefined);
      assert.equal(result.headers['set-cookie'], undefined);
      assert.equal(result.headers['www-authenticate'], undefined);
      assert.ok(!result.body.includes('Demo password'));
    }
    assert.equal(seen.length, 4);
    const oldBookmark = await request(f.gateway, {path: '/__demo/access?next=https://evil.example'});
    assert.equal(oldBookmark.status, 303);
    assert.equal(oldBookmark.headers.location, '/login');
    assert.equal((await login(f.gateway)).status, 405);
    assert.equal(seen.length, 4);
    await assert.rejects(startDemoGateway({port: 0, apiPort: f.upstream.address().port, username, password, requireAccess: 'false'}), /DEMO_GATEWAY_OPTIONS_INVALID/u);
  } finally {await f.close();}
});

test('public demo preserves application auth failures, private-path denial and separate app cookies', async () => {
  const seen = [];
  const f = await fixture((req, res) => {
    seen.push(req.headers);
    const signedIn = req.headers.cookie === 'session=app-session';
    res.writeHead(signedIn ? 200 : 401, {'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="upstream"'});
    res.end(signedIn ? '{"user":"test-user"}' : '{"error":{"code":"AUTH_REQUIRED"}}');
  }, {requireAccess: false});
  try {
    f.gateway.setOrigin(origin);
    const unauthenticated = await request(f.gateway, {path: '/api/v1/auth/me'});
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.body, '{"error":{"code":"AUTH_REQUIRED"}}');
    assert.equal(unauthenticated.headers['www-authenticate'], undefined);
    const signedIn = await request(f.gateway, {path: '/api/v1/auth/me', headers: {Cookie: '__Host-avs_demo=old-gate-session; session=app-session', Authorization: authorization}});
    assert.equal(signedIn.status, 200);
    assert.equal(seen[1].cookie, 'session=app-session');
    assert.equal(seen[1].authorization, undefined);
    for (const route of ['/.env', '/var/demo/access.txt', '/docs/spec.md', '/.git/config', '/%252eenv', '/app%5c..%5cops/private']) {
      const denied = await request(f.gateway, {path: route});
      assert.equal(denied.status, 404);
      assert.equal(denied.headers['cache-control'], 'no-store');
    }
    assert.equal((await request(f.gateway, {headers: {Host: 'evil.example'}})).status, 421);
    assert.equal(seen.length, 2);
  } finally {await f.close();}
});
