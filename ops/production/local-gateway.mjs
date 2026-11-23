import https from 'node:https';
import http from 'node:http';
import {isLocalHostname, readLocalCertificate} from '../../scripts/local-production-certificate.mjs';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers, request = false) {
  const excluded = new Set([...hop, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  if (request) for (const key of Object.keys(headers)) if (key === 'forwarded' || key.startsWith('x-forwarded-') || key === 'x-real-ip') excluded.add(key);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

/** This gateway is intentionally loopback-only; it is not a public TLS gateway. */
export async function startLocalGateway({origin, apiPort, certFile, keyFile}) {
  const target = new URL(origin), port = Number(target.port);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/' || !isLocalHostname(target.hostname) || !Number.isSafeInteger(port) || port < 1024 || port > 65535 || !Number.isSafeInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || apiPort === port) throw new Error('LOCAL_GATEWAY_OPTIONS_INVALID');
  const tls = await readLocalCertificate({certFile, keyFile, hostname: target.hostname});
  const server = https.createServer({key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', maxHeaderSize: 16384}, (request, response) => {
    if (String(request.headers.host || '').toLowerCase() !== target.host) {response.writeHead(421, {'Cache-Control': 'no-store'}); response.end('Local hostname mismatch.'); return;}
    const headers = {...cleanHeaders(request.headers, true), host: target.host, 'x-forwarded-host': target.host, 'x-forwarded-proto': 'https', 'x-forwarded-for': request.socket.remoteAddress};
    const upstream = http.request({host: '127.0.0.1', port: apiPort, method: request.method, path: request.url, headers, timeout: 120000}, incoming => {
      response.writeHead(incoming.statusCode, cleanHeaders(incoming.headers));
      incoming.once('error', () => response.destroy()); incoming.pipe(response);
    });
    upstream.once('timeout', () => upstream.destroy());
    upstream.once('error', () => {if (!response.headersSent) {response.writeHead(502, {'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8'}); response.end('The local application is unavailable.');} else response.destroy();});
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => {if (!response.writableFinished) upstream.destroy();});
    request.pipe(upstream);
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', () => {server.off('error', reject); resolve();});});
  return server;
}
