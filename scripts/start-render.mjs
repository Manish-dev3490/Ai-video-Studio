import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {buildRenderProfile} from '../ops/render/profile.mjs';
import {startRenderGateway} from '../ops/render/gateway.mjs';
import {repositoryRoot} from '../ops/production/profile.mjs';
import {ensureDirectoryUnder} from '../apps/api/src/jobs/files.js';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function checkInternalPort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('RENDER_INTERNAL_PORT_IN_USE')));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => server.close(resolve));
}

/** Render web/API profile only. No local database, tunnel or rendering worker. */
export async function startRender({environment = process.env, onEvent = event => process.stdout.write(JSON.stringify(event) + '\n')} = {}) {
  const profile = buildRenderProfile(environment);
  await fs.access(path.join(repositoryRoot, 'apps/web/dist/index.html'));
  await checkInternalPort(profile.apiPort);
  for (const directory of [profile.config.storageRoot, profile.config.workerWorkRoot, profile.config.mailPreviewRoot]) await ensureDirectoryUnder(repositoryRoot, directory);
  let gateway, child, stopping = false, stopPromise;
  const interrupt = () => {void stop(0);};
  const disconnected = () => {void stop(1);};
  const detach = () => {process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); process.off('disconnect', disconnected);};
  function stop(code = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      if (gateway) await gateway.close();
      const alive = () => child && child.exitCode === null && child.signalCode === null;
      if (alive()) {
        if (child.connected) {try {child.send({type: 'AVS_API_STOP'});} catch { /* Child already stopped. */ }}
        else child.kill('SIGTERM');
        for (let count = 0; count < 120 && alive(); count++) await pause(100);
        if (alive()) child.kill('SIGTERM');
        for (let count = 0; count < 20 && alive(); count++) await pause(100);
        if (alive()) child.kill('SIGKILL');
      }
      detach();
      process.exitCode = code;
      onEvent({event: 'RENDER_WEB_STOPPED'});
    })();
    return stopPromise;
  }
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  if (process.send) process.once('disconnect', disconnected);
  try {
    gateway = await startRenderGateway({port: profile.port, apiPort: profile.apiPort, origin: profile.origin});
    if (stopping) {await gateway.close(); throw new Error('RENDER_START_CANCELLED');}
    // Allowlist the child's environment: no Render account token, Git token or
    // unrelated hosting credential is passed to the API process.
    const operatingEnvironment = {};
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) if (process.env[name]) operatingEnvironment[name] = process.env[name];
    child = fork(path.join(repositoryRoot, 'apps/api/src/server.js'), [], {cwd: repositoryRoot, execArgv: [], windowsHide: true, env: {...operatingEnvironment, ...profile.environment}, stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
    child.once('error', () => {if (!stopping) void stop(1);});
    child.once('exit', () => {if (!stopping) void stop(1);});
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${profile.apiPort}/api/v1/ready`, {signal: AbortSignal.timeout(1000)});
        ready = response.status === 200;
        await response.body?.cancel();
        if (ready) break;
      } catch { /* Readiness remains false until the real API and database respond. */ }
      await pause(200);
    }
    if (!ready || stopping) throw new Error('RENDER_API_NOT_READY');
    onEvent({event: 'RENDER_WEB_ONLINE', origin: profile.origin, mailEnabled: false, renderingWorkerStarted: false, storage: 'EPHEMERAL', accessMode: 'APP_LOGIN_ONLY'});
    return {stop, gateway, child};
  } catch (error) {await stop(1); throw error;}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {process.stderr.write('Usage: node scripts/start-render.mjs\n'); process.exitCode = 1;}
  else await startRender().catch(() => {process.stderr.write('Render web startup failed. Check the configured origin, secrets, Atlas connection and build. No environment values were logged.\n'); process.exitCode = 1;});
}
