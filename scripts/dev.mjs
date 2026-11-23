import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {startLocalMongo, isPortOpen} from './local-mongo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let mongo;
let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.avsWorker && child.connected) child.send({type: 'AVS_WORKER_STOP'});
  for (let count = 0; count < 100 && children.some(child => child.avsWorker && child.exitCode === null); count++) await new Promise(resolve => setTimeout(resolve, 100));
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    if (process.platform === 'win32') {
      // Node --watch has its own server child. Stop only this launcher's live
      // child tree, never a port-wide or name-wide selection of user processes.
      const stoppingChild = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      stoppingChild.once('error', () => {child.kill(); resolve();});
      stoppingChild.once('exit', () => resolve());
    } else {child.kill('SIGTERM'); resolve();}
  })));
  if (mongo) await mongo.stop();
  process.exitCode = exitCode;
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());

try {
  process.loadEnvFile(path.join(root, '.env'));
  const apiPort = Number(process.env.API_PORT || 4100);
  const webPort = Number(new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:5173').port || 5173);
  if (await isPortOpen(apiPort) || await isPortOpen(webPort)) throw new Error('APPLICATION_PORT_IN_USE');
  const dedicatedUri = 'mongodb://127.0.0.1:27018/ai_video_studio_phase3';
  if ([dedicatedUri, dedicatedUri + '?replicaSet=avsLocal'].includes(process.env.MONGODB_URI)) {
    mongo = await startLocalMongo({directory: path.join(root, '.cache/phase3-mongodb'), port: 27018, replicaSet: 'avsLocal'});
    process.env.MONGODB_URI = dedicatedUri + '?replicaSet=avsLocal';
    process.stdout.write('Dedicated local MongoDB replica set started on loopback port 27018. Existing accounts and service/data are preserved.\n');
  }
  const launch = (args, cwd, essential = true) => {
    const child = spawn(process.execPath, args, {cwd, env: process.env, windowsHide: true, stdio: essential ? 'inherit' : ['inherit', 'inherit', 'inherit', 'ipc']});
    child.avsWorker = !essential;
    children.push(child);
    child.once('error', () => {if (essential) stop(1); else process.stderr.write('Video worker unavailable; the application remains running.\n');});
    child.once('exit', code => {if (!stopping) {if (essential) stop(code || 0); else process.stderr.write('Video worker stopped; the application remains running. Restart the worker after resolving its local setup.\n');}});
  };
  await fs.access(path.join(root, 'node_modules/vite/bin/vite.js'));
  launch(['--watch', 'src/server.js'], path.join(root, 'apps/api'));
  launch([path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], path.join(root, 'apps/web'));
  if (process.env.WORKER_ENABLED !== 'false') launch(['src/main.js'], path.join(root, 'apps/worker'), false);
  process.stdout.write(`Open ${process.env.APP_ORIGIN || 'http://127.0.0.1:5173'} — signup creates a real local account. Ctrl+C stops these development processes.\n`);
} catch (error) {
  const code = /^[A-Z0-9_]+$/u.test(error.message || '') ? error.message : error.code === 'ENOENT' ? 'LOCAL_SETUP_REQUIRED' : 'DEVELOPMENT_START_FAILED';
  process.stderr.write(`${code}: run npm run setup:local, check the installed MongoDB binary and select unused local ports. Secret values are not logged.\n`);
  await stop(1);
}
