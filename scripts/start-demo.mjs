import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {fork, spawn} from 'node:child_process';
import {repositoryRoot} from '../ops/production/profile.mjs';
import {demoRoot, tunnelFile, tunnelDigest, initializeDemoProfile, readDemoProfile, assessDemoProfile, publicDemoOrigin} from '../ops/demo/profile.mjs';
import {startDemoGateway} from '../ops/demo/gateway.mjs';
import {startLocalMongo, isPortOpen} from './local-mongo.mjs';
import {productionChildEnvironment} from './start-production.mjs';
import {ensureDirectoryUnder} from '../apps/api/src/jobs/files.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startDemo({requireAccess = true, onEvent = event => process.stdout.write(JSON.stringify(event) + '\n')} = {}) {
  if (process.platform !== 'win32') throw new Error('WINDOWS_RENDERER_REQUIRED');
  if (typeof requireAccess !== 'boolean') throw new Error('DEMO_ACCESS_MODE_INVALID');
  await initializeDemoProfile();
  const profile = await readDemoProfile();
  if (!assessDemoProfile(profile, 'https://preflight-only.trycloudflare.com').passed) throw new Error('DEMO_PROFILE_INVALID');
  const executable = await fs.lstat(tunnelFile);
  if (!executable.isFile() || executable.isSymbolicLink() || path.relative(await fs.realpath(tunnelFile), tunnelFile)) throw new Error('VERIFIED_PORTABLE_TUNNEL_REQUIRED');
  if (createHash('sha256').update(await fs.readFile(tunnelFile)).digest('hex') !== tunnelDigest) throw new Error('TUNNEL_INTEGRITY_CHECK_FAILED');
  for (const port of [4300, 4301, 27020, 49313]) if (await isPortOpen(port)) throw new Error('DEMO_PORT_IN_USE');
  await fs.access(path.join(repositoryRoot, 'apps/web/dist/index.html'));
  const children = [];
  let mongo, gateway, tunnel, stopping = false, stopPromise, stopPoll;
  const runId = `${process.pid}-${Date.now()}`;
  const statusFile = path.join(demoRoot, 'status.json'), stopFile = path.join(demoRoot, 'stop.request');
  const signal = () => void stop(0);
  const ipc = message => {if (message?.type === 'AVS_DEMO_STOP') signal();};
  const detach = () => {process.off('SIGINT', signal); process.off('SIGTERM', signal); process.off('disconnect', signal); process.off('message', ipc);};
  async function terminate(child) {
    const alive = () => child?.pid && child.exitCode === null && child.signalCode === null;
    if (!alive()) return;
    if (child.connected) {try {child.send({type: child.avsWorker ? 'AVS_WORKER_STOP' : 'AVS_API_STOP'});} catch { /* Already disconnected. */ }}
    else child.kill();
    for (let i = 0; i < (child.avsWorker ? 300 : 120) && alive(); i++) await pause(100);
    if (alive()) await new Promise(resolve => {const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); killer.once('error', resolve); killer.once('exit', resolve);});
  }
  function stop(code = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(stopPoll);
    stopPromise = (async () => {
      await terminate(tunnel);
      if (gateway) await gateway.close();
      for (const child of [...children].reverse()) await terminate(child);
      if (mongo) await mongo.stop();
      await fs.writeFile(statusFile, JSON.stringify({online: false, runId, stoppedAt: new Date().toISOString(), temporary: true}, null, 2) + '\n').catch(() => {});
      detach(); process.exitCode = code; onEvent({event: 'TEMPORARY_DEMO_STOPPED'});
    })();
    return stopPromise;
  }
  process.once('SIGINT', signal); process.once('SIGTERM', signal); process.on('message', ipc);
  if (process.send) process.once('disconnect', signal);
  try {
    for (const directory of ['media', 'jobs', 'mail-disabled', 'mongodb', 'tunnel-home']) await ensureDirectoryUnder(repositoryRoot, path.join(demoRoot, directory));
    gateway = await startDemoGateway({port: 4301, apiPort: 4300, username: profile.DEMO_GATE_USER, password: profile.DEMO_GATE_PASSWORD, requireAccess});
    if (stopping) {await gateway.close(); throw new Error('DEMO_START_CANCELLED');}
    const tunnelEnvironment = productionChildEnvironment({});
    Object.assign(tunnelEnvironment, {USERPROFILE: path.join(demoRoot, 'tunnel-home'), HOME: path.join(demoRoot, 'tunnel-home')});
    // Constant origin and a private HOME keep existing tunnels/configurations untouched.
    tunnel = spawn(tunnelFile, ['tunnel', '--url', 'http://127.0.0.1:4301', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:49313', '--loglevel', 'info'], {cwd: repositoryRoot, windowsHide: true, env: tunnelEnvironment, stdio: ['ignore', 'pipe', 'pipe']});
    let tunnelOutput = '', origin, tunnelFailed = false;
    const capture = chunk => {tunnelOutput = (tunnelOutput + chunk.toString()).slice(-64000); const match = tunnelOutput.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/u); if (match) origin = publicDemoOrigin(match[0]);};
    tunnel.stdout.on('data', capture); tunnel.stderr.on('data', capture);
    tunnel.once('error', () => {tunnelFailed = true; if (origin && !stopping) void stop(1);});
    tunnel.once('exit', () => {tunnelFailed = true; if (origin && !stopping) void stop(1);});
    for (let i = 0; i < 200 && !origin && !tunnelFailed && !stopping; i++) await pause(250);
    if (!origin || tunnelFailed || stopping) throw new Error('TEMPORARY_TUNNEL_START_FAILED');
    const environment = {...profile, APP_ORIGIN: origin};
    delete environment.DEMO_GATE_USER; delete environment.DEMO_GATE_PASSWORD;
    const assessment = assessDemoProfile(profile, origin);
    if (!assessment.passed) throw new Error('DEMO_PUBLIC_ORIGIN_INVALID');
    mongo = await startLocalMongo({directory: path.join(demoRoot, 'mongodb'), port: 27020, replicaSet: 'avsDemoLocal', ...(profile.MONGOD_BINARY ? {binary: profile.MONGOD_BINARY} : {})});
    if (stopping) {await mongo.stop(); throw new Error('DEMO_START_CANCELLED');}
    const launch = (entry, worker) => {
      if (stopping) throw new Error('DEMO_START_CANCELLED');
      const child = fork(path.join(repositoryRoot, entry), [], {cwd: repositoryRoot, execArgv: [], env: productionChildEnvironment(environment, worker), windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
      child.avsWorker = worker; children.push(child);
      child.once('error', () => {if (!stopping) void stop(1);}); child.once('exit', code => {if (!stopping) void stop(code || 1);});
      return child;
    };
    launch('apps/api/src/server.js', false);
    let ready = false;
    for (let i = 0; i < 100 && !stopping; i++) {try {const response = await fetch('http://127.0.0.1:4300/api/v1/ready', {signal: AbortSignal.timeout(750)}); if (response.status === 200) {ready = true; break;}} catch {} await pause(200);}
    if (!ready || stopping) throw new Error('DEMO_API_NOT_READY');
    launch('apps/worker/src/main.js', true);
    gateway.setOrigin(origin);
    const accessMode = requireAccess ? 'COOKIE_FORM' : 'APP_LOGIN_ONLY';
    const status = {online: true, runId, origin, temporary: true, mailEnabled: false, passwordProtected: requireAccess, accessMode, startedAt: new Date().toISOString(), supervisorPid: process.pid};
    const accessDetails = requireAccess
      ? `Username: ${profile.DEMO_GATE_USER}\nPassword: ${profile.DEMO_GATE_PASSWORD}\n\nOpen the URL and enter these details on the Demo access page. There is no browser password popup. After opening the demo, sign up or log in separately inside the app.\n`
      : 'Open the URL and sign up or log in inside the app. No separate demo username, password or access prompt is required.\n';
    await fs.writeFile(path.join(demoRoot, 'access.txt'), `AI Video Studio temporary demo\nURL: ${origin}\n${accessDetails}\nKeep the laptop and demo process running. Email verification/reset are unavailable.\n`, {mode: 0o600});
    await fs.writeFile(statusFile, JSON.stringify(status, null, 2) + '\n');
    if (stopping) {await stopPromise; await fs.writeFile(statusFile, JSON.stringify({online: false, runId, temporary: true}, null, 2) + '\n'); throw new Error('DEMO_START_CANCELLED');}
    let checkingStop = false;
    stopPoll = setInterval(async () => {
      if (checkingStop || stopping) return;
      checkingStop = true;
      try {if ((await fs.readFile(stopFile, 'utf8')).trim() === runId) void stop(0);} catch {} finally {checkingStop = false;}
    }, 1000).unref();
    onEvent({event: 'TEMPORARY_DEMO_ONLINE', origin, temporary: true, passwordProtected: requireAccess, accessMode, accessFile: 'var/demo/access.txt', mailEnabled: false});
    return {stop, children, gateway, origin};
  } catch (error) {await stop(1); throw error;}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) process.stdout.write('node scripts/start-demo.mjs [--init | --public]\nPortable temporary Cloudflare demo. Default: separate demo access form. --public: normal app signup/login only. Windows laptop must remain on. No system services or public database.\n');
  else if (process.argv.length > 2 && !(process.argv.length === 3 && ['--init', '--public'].includes(process.argv[2]))) {process.stderr.write('Invalid demo arguments. Use --help.\n'); process.exitCode = 1;}
  else if (process.argv[2] === '--init') await initializeDemoProfile().then(result => process.stdout.write(JSON.stringify({event: 'DEMO_PROFILE_INITIALIZED', ...result}) + '\n'));
  else await startDemo({requireAccess: process.argv[2] !== '--public'}).catch(error => {process.stderr.write(JSON.stringify({event: 'TEMPORARY_DEMO_FAILED', code: /^[A-Z_]+$/u.test(error.message) ? error.message : 'DEMO_START_FAILED', message: 'Temporary demo could not start; existing development/production profiles are preserved.'}) + '\n'); process.exitCode = 1;});
}
