import http from 'node:http';
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import path from 'node:path';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const digest = value => createHash('sha256').update(value).digest();
const privateRoots = new Set(['.git', '.codex', '.agents', '.aws', 'var', 'docs', 'review', 'video-engine-poc', 'packages', 'ops', 'scripts']);

export function parseDemoOrigin(value) {
  let origin;
  try {origin = new URL(value);} catch {throw new Error('DEMO_ORIGIN_INVALID');}
  if (typeof value !== 'string' || origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(origin.hostname)) throw new Error('DEMO_ORIGIN_INVALID');
  return origin;
}

function cleanHeaders(headers, request = false) {
  const excluded = new Set([...hopHeaders, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  if (request) for (const name of Object.keys(headers)) if (name === 'authorization' || name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip' || name.startsWith('cf-')) excluded.add(name);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function validTarget(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x20\x7f]/u.test(value)) return false;
  try {return !/[\x00-\x1f\x7f]/u.test(decodeURIComponent(value));} catch {return false;}
}

function privateTarget(value) {
  let decoded = value.split('?')[0];
  // Check each decoding layer, normalizing both URL and Windows separators.
  // Excessive or malformed nested encoding fails closed after authentication.
  for (let depth = 0; depth < 5; depth++) {
    const windowsPath = decoded.split(/[?#]/u)[0].replaceAll('\\', '/').split('/').map(segment => {
      const trimmed = segment.replace(/ +$/u, '');
      return ['.', '..'].includes(trimmed) ? trimmed : trimmed.replace(/[. ]+$/u, '');
    }).join('/');
    const top = path.posix.normalize('/' + windowsPath).replace(/^\/+/, '').split('/')[0].split(':')[0].toLowerCase();
    if (top === '.env' || top.startsWith('.env.') || privateRoots.has(top)) return true;
    let next;
    try {next = decodeURIComponent(decoded);} catch {return true;}
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}

const gateCookieName = '__Host-avs_demo';
const gateLifetimeSeconds = 8 * 60 * 60;
const accessPath = '/__demo/access';
const escapeHtml = value => String(value).replace(/[&<>"']/gu, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
const securityHeaders = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'Strict-Transport-Security': 'max-age=31536000'};
function safeNext(value) {
  if (!value || typeof value !== 'string' || !validTarget(value) || privateTarget(value)) return null;
  let decoded = value;
  for (let depth = 0; depth < 5; depth++) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x20\x7f]/u.test(decoded)) return null;
    let next; try {next = decodeURIComponent(decoded);} catch {return null;}
    if (next === decoded) break;
    decoded = next;
    if (depth === 4) return null;
  }
  const url = new URL(value, 'https://demo.invalid');
  if (url.origin !== 'https://demo.invalid' || url.pathname.startsWith('/__demo/')) return null;
  return url.pathname + url.search;
}
function accessPage(next, message = '') {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo access · AI Video Studio</title><style>body{margin:0;background:#f4f5f7;color:#182231;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{box-sizing:border-box;width:min(92vw,420px);padding:32px;background:white;border:1px solid #dfe3e8;border-radius:20px;box-shadow:0 14px 50px #18223110}h1{font-size:26px;margin:10px 0}p{line-height:1.5;color:#536171}.eyebrow{font-size:12px;letter-spacing:.13em;color:#386355;font-weight:700}label{display:block;font-weight:600;font-size:14px;margin-top:18px}input{box-sizing:border-box;width:100%;border:1px solid #b9c3ce;border-radius:9px;padding:12px;margin-top:7px;font:inherit}button{width:100%;border:0;border-radius:9px;padding:13px;background:#1d5947;color:white;font:600 16px system-ui;margin-top:24px;cursor:pointer}input:focus,button:focus{outline:3px solid #74bba5;outline-offset:2px}.error{padding:12px;border:1px solid #e7a8a8;border-radius:8px;background:#fff3f3;color:#8b2424}.note{font-size:13px;margin-bottom:0}</style></head><body><main><span class="eyebrow">AI VIDEO STUDIO · PRIVATE PREVIEW</span><h1>Open the studio demo</h1><p>Enter the demo access details shared with you. After this, create an account or sign in to your studio workspace.</p>' + (message ? '<p class="error" role="alert">' + escapeHtml(message) + '</p>' : '') + '<form method="post" action="' + accessPath + '"><input type="hidden" name="next" value="' + escapeHtml(next) + '"><label for="demo-username">Demo username</label><input id="demo-username" name="username" autocomplete="username" required maxlength="80" autofocus><label for="demo-password">Demo password</label><input id="demo-password" name="password" type="password" autocomplete="current-password" required maxlength="200"><button type="submit">Open demo</button></form><p class="note">This demo access is separate from your studio account.</p></main></body></html>';
}
function readForm(request) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false; const chunks = [];
    const finish = (error, value) => {if (settled) return; settled = true; clearTimeout(timeout); if (error) {request.resume(); reject(error);} else resolve(value);};
    const timeout = setTimeout(() => finish(new Error('FORM_TIMEOUT')), 10000).unref();
    request.on('data', chunk => {if (settled) return; size += chunk.length; if (size > 4096) finish(new Error('FORM_TOO_LARGE')); else chunks.push(chunk);});
    request.once('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    request.once('aborted', () => finish(new Error('FORM_ABORTED')));
    request.once('error', () => finish(new Error('FORM_ABORTED')));
  });
}

/** Private loopback origin for one explicitly selected temporary Cloudflare URL. */
export async function startDemoGateway({port, apiPort, username, password, requireAccess = true, now = Date.now}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || port === apiPort || typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,39}$/u.test(username) || typeof password !== 'string' || password.length < 24 || password.length > 128 || /[^\x21-\x7e]/u.test(password) || typeof requireAccess !== 'boolean' || typeof now !== 'function') throw new Error('DEMO_GATEWAY_OPTIONS_INVALID');
  const credentialDigest = digest(username + '\0' + password), signingKey = randomBytes(32), attempts = new Map();
  let origin;
  const sign = value => createHmac('sha256', signingKey).update(origin.origin + '|' + value).digest('base64url');
  function validSession(header) {
    if (typeof header !== 'string') return false;
    const values = header.split(';').map(value => value.trim()).filter(value => value.startsWith(gateCookieName + '=')).map(value => value.slice(gateCookieName.length + 1));
    if (values.length !== 1) return false;
    const token = values[0], match = /^(\d{10,13})\.([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/u.exec(token);
    if (!match) return false;
    const expiry = Number(match[1]), seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(expiry) || expiry <= seconds || expiry > seconds + gateLifetimeSeconds) return false;
    return timingSafeEqual(digest(match[3]), digest(sign(match[1] + '.' + match[2])));
  }
  function permitAttempt(client) {
    const time = now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    let bucket = attempts.get(client);
    if (!bucket) {if (attempts.size >= 1000) return false; bucket = {until: time + 15 * 60 * 1000, count: 0}; attempts.set(client, bucket);}
    if (bucket.count >= 10) return false;
    bucket.count++; return true;
  }
  const server = http.createServer({maxHeaderSize: 16384}, async (request, response) => {
    const refuse = (status, message, headers = {}) => {response.writeHead(status, {...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8', ...headers}); response.end(message); request.resume();};
    const redirect = (location, cookie) => {response.writeHead(303, {...securityHeaders, Location: location, ...(cookie ? {'Set-Cookie': cookie} : {})}); response.end(); request.resume();};
    // Same-origin form navigation must retain Origin for the strict POST guard.
    // no-referrer makes Chromium send Origin:null on this HTML form submission.
    const form = (status, next, message = '') => {response.writeHead(status, {...securityHeaders, 'Referrer-Policy': 'same-origin', 'Content-Type': 'text/html; charset=utf-8'}); response.end(request.method === 'HEAD' ? '' : accessPage(next, message)); request.resume();};
    try {
      if (!validTarget(request.url)) {refuse(400, 'Invalid demo request.'); return;}
      if (!origin) {refuse(503, 'The temporary demo is starting.'); return;}
      if (request.headers.host !== origin.host) {refuse(421, 'Demo hostname mismatch.'); return;}
      if (request.headers.upgrade || ['CONNECT', 'TRACE'].includes(request.method)) {refuse(405, 'This request method is unavailable.'); return;}
      const url = new URL(request.url, origin), authenticated = !requireAccess || validSession(request.headers.cookie);
      const suppliedClient = request.headers['cf-connecting-ip'];
      const client = typeof suppliedClient === 'string' && isIP(suppliedClient) ? suppliedClient : '127.0.0.1';
      if (url.pathname === accessPath) {
        if (!requireAccess) {
          if (['GET', 'HEAD'].includes(request.method)) redirect('/login');
          else refuse(405, 'The studio uses its normal signup and login pages.');
          return;
        }
        const next = url.searchParams.getAll('next').length === 1 ? safeNext(url.searchParams.get('next')) || '/login' : '/login';
        if (['GET', 'HEAD'].includes(request.method)) {if (authenticated) redirect(next); else form(200, next); return;}
        if (request.method !== 'POST') {refuse(405, 'This request method is unavailable.'); return;}
        if (request.headers.origin !== origin.origin) {refuse(403, 'Open the demo access page and try again.'); return;}
        if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] || '')) {refuse(415, 'Use the demo access form.'); return;}
        if (!permitAttempt(client)) {form(429, next, 'Too many attempts. Please wait 15 minutes before trying again.'); return;}
        if (Number(request.headers['content-length'] || 0) > 4096) {refuse(413, 'The access form is too large.'); return;}
        let body; try {body = await readForm(request);} catch (error) {refuse(error.message === 'FORM_TOO_LARGE' ? 413 : 400, 'The access form could not be read.'); return;}
        const fields = new URLSearchParams(body), keys = [...fields.keys()];
        if (keys.some(key => !['username', 'password', 'next'].includes(key)) || keys.length !== new Set(keys).size || !fields.has('username') || !fields.has('password')) {form(400, next, 'Enter the demo username and password using this form.'); return;}
        const destination = fields.has('next') ? safeNext(fields.get('next')) : '/login';
        if (!destination) {form(400, '/login', 'Open the demo access page and try again.'); return;}
        const suppliedUsername = fields.get('username').trim(), suppliedPassword = fields.get('password').trim();
        if (suppliedUsername.length > 80 || suppliedPassword.length > 200 || !timingSafeEqual(digest(suppliedUsername + '\0' + suppliedPassword), credentialDigest)) {form(403, destination, 'The demo username or password is incorrect. Please try again.'); return;}
        attempts.delete(client);
        const value = String(Math.floor(now() / 1000) + gateLifetimeSeconds) + '.' + randomBytes(24).toString('base64url');
        redirect(destination, gateCookieName + '=' + value + '.' + sign(value) + '; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=' + gateLifetimeSeconds); return;
      }
      if (url.pathname === '/__demo/exit') {
        if (request.method !== 'POST') {refuse(405, 'This request method is unavailable.'); return;}
        if (request.headers.origin !== origin.origin) {refuse(403, 'Open the demo access page and try again.'); return;}
        redirect(requireAccess ? accessPath : '/login', gateCookieName + '=; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=0'); return;
      }
      if (!authenticated) {
        const navigation = ['GET', 'HEAD'].includes(request.method) && /(?:^|,)\s*text\/html(?:[;,]|$)/iu.test(request.headers.accept || '') && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/');
        if (navigation) redirect(accessPath + '?next=' + encodeURIComponent(safeNext(request.url) || '/login'));
        else refuse(403, 'Demo access expired or missing. Open /__demo/access to enter the demo password.');
        return;
      }
      if (privateTarget(request.url)) {refuse(404, 'Not found.'); return;}
      const headers = {...cleanHeaders(request.headers, true), host: origin.host, 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': client};
      const applicationCookies = String(request.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value && value.split('=')[0].trim() !== gateCookieName).join('; ');
      if (applicationCookies) headers.cookie = applicationCookies; else delete headers.cookie;
      const upstream = http.request({hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method, headers, timeout: 120000}, incoming => {
        const responseHeaders = cleanHeaders(incoming.headers); delete responseHeaders['www-authenticate'];
        const cookies = responseHeaders['set-cookie'];
        if (cookies) responseHeaders['set-cookie'] = cookies.filter(cookie => !cookie.trimStart().startsWith(gateCookieName + '='));
        // Quick Tunnel may replace JSON 502/504 responses with its own error
        // page. Preserve API error bytes using another error status at this
        // demo edge only; the backend contract remains unchanged.
        let status = incoming.statusCode;
        if (url.pathname.startsWith('/api/v1/') && [502, 504].includes(status) && String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json') {
          responseHeaders['x-avs-origin-status'] = String(status);
          responseHeaders['cache-control'] = 'no-store';
          status = 503;
        }
        response.writeHead(status, responseHeaders);
        incoming.once('error', () => response.destroy()); incoming.pipe(response);
      });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => {if (!response.headersSent) refuse(502, 'The demo application is unavailable.'); else response.destroy();});
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => {if (!response.writableFinished) upstream.destroy();});
      request.pipe(upstream);
    } catch {if (!response.headersSent) refuse(500, 'The demo request could not be completed.'); else response.destroy();}
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  server.on('connect', (request, socket) => {socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  server.on('clientError', (error, socket) => {if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', () => {server.off('error', reject); resolve();});});
  return {
    server,
    setOrigin(value) {const next = parseDemoOrigin(value); if (origin && origin.origin !== next.origin) throw new Error('DEMO_ORIGIN_ALREADY_LOCKED'); origin = next;},
    close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections?.();}),
  };
}
