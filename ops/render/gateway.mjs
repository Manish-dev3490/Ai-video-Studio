import http from 'node:http';
import {isIP} from 'node:net';
import path from 'node:path';
import {parseRenderOrigin} from './profile.mjs';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const privateRoots = new Set(['var', 'docs', 'review', 'video-engine-poc', 'packages', 'ops', 'scripts', 'apps', 'artifacts', 'node_modules', 'package.json', 'package-lock.json', 'render.yaml', 'readme.md']);
const securityHeaders = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'};
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
  for (let depth = 0; depth < 5; depth++) {
    const windowsPath = decoded.split(/[?#]/u)[0].replaceAll('\\', '/').split('/').map(segment => {
      const trimmed = segment.replace(/ +$/u, '');
      return ['.', '..'].includes(trimmed) ? trimmed : trimmed.replace(/[. ]+$/u, '');
    }).join('/');
    const top = path.posix.normalize('/' + windowsPath).replace(/^\/+/, '').split('/')[0].split(':')[0].toLowerCase();
    if (top.startsWith('.') || privateRoots.has(top)) return true;
    let next;
    try {next = decodeURIComponent(decoded);} catch {return true;}
    if (next === decoded) return false;
    decoded = next;
  }
  return true;
}
function clientAddress(request) {
  // This listener must sit behind Render's edge, which appends the actual
  // client to X-Forwarded-For. Never trust the user-controlled leftmost entry.
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const rightmost = forwarded.split(',').at(-1).trim();
    if (isIP(rightmost)) return rightmost;
  }
  const socket = request.socket.remoteAddress;
  return typeof socket === 'string' && isIP(socket) ? socket : '127.0.0.1';
}

/** Public Render listener; the application itself remains loopback-only. */
export async function startRenderGateway({port, apiPort, origin: value, host = '0.0.0.0'}) {
  const origin = parseRenderOrigin(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || port === apiPort || !['0.0.0.0', '127.0.0.1'].includes(host)) throw new Error('RENDER_GATEWAY_OPTIONS_INVALID');
  const server = http.createServer({maxHeaderSize: 16384}, (request, response) => {
    const refuse = (status, message) => {response.writeHead(status, {...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8'}); response.end(message); request.resume();};
    try {
      if (!validTarget(request.url)) {refuse(400, 'Invalid request.'); return;}
      const health = ['GET', 'HEAD'].includes(request.method) && request.url === '/api/v1/ready';
      if (!health && request.headers.host !== origin.host) {refuse(421, 'Hostname mismatch.'); return;}
      if (request.headers.upgrade || ['CONNECT', 'TRACE'].includes(request.method)) {refuse(405, 'This request method is unavailable.'); return;}
      const protocol = request.headers['x-forwarded-proto'];
      if (!health && protocol !== undefined && protocol !== 'https') {refuse(426, 'Open the studio using HTTPS.'); return;}
      if (privateTarget(request.url)) {refuse(404, 'Not found.'); return;}
      const headers = {...cleanHeaders(request.headers, true), host: origin.host, 'x-forwarded-host': origin.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': clientAddress(request)};
      const applicationCookies = String(request.headers.cookie || '').split(';').map(cookie => cookie.trim()).filter(cookie => cookie && cookie.split('=')[0].trim() !== '__Host-avs_demo').join('; ');
      if (applicationCookies) headers.cookie = applicationCookies; else delete headers.cookie;
      const upstream = http.request({hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method, headers, timeout: 150000}, incoming => {
        const responseHeaders = cleanHeaders(incoming.headers);
        delete responseHeaders['www-authenticate'];
        if (responseHeaders['set-cookie']) responseHeaders['set-cookie'] = responseHeaders['set-cookie'].filter(cookie => !cookie.trimStart().startsWith('__Host-avs_demo='));
        response.writeHead(incoming.statusCode, responseHeaders);
        incoming.once('error', () => response.destroy());
        incoming.pipe(response);
      });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => {if (!response.headersSent) refuse(502, 'The studio is temporarily unavailable.'); else response.destroy();});
      request.once('aborted', () => upstream.destroy());
      response.once('close', () => {if (!response.writableFinished) upstream.destroy();});
      request.pipe(upstream);
    } catch {if (!response.headersSent) refuse(500, 'The request could not be completed.'); else response.destroy();}
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  server.on('connect', (request, socket) => {socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  server.on('clientError', (error, socket) => {if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, host, () => {server.off('error', reject); resolve();});});
  return {server, close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections?.();})};
}
