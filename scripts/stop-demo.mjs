import fs from 'node:fs/promises';
import path from 'node:path';
import {demoRoot} from '../ops/demo/profile.mjs';
try {
  const statusFile = path.join(demoRoot, 'status.json');
  const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  if (!status.online) process.stdout.write('Temporary demo is already offline.\n');
  else {
    if (!/^[0-9]+-[0-9]+$/u.test(status.runId || '')) throw new Error('DEMO_STATUS_INVALID');
    const request = path.join(demoRoot, 'stop.request');
    try {if (!(await fs.lstat(request)).isFile() || (await fs.lstat(request)).isSymbolicLink()) throw new Error('DEMO_STOP_PATH_INVALID');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    await fs.writeFile(request, status.runId + '\n', {mode: 0o600});
    let stopped = false;
    for (let i = 0; i < 55; i++) {await new Promise(resolve => setTimeout(resolve, 1000)); const current = JSON.parse(await fs.readFile(statusFile, 'utf8')); if (current.runId !== status.runId || current.online === false) {stopped = true; break;}}
    if (!stopped) throw new Error('DEMO_STOP_NOT_CONFIRMED');
    process.stdout.write('Temporary demo and its owned services stopped. Existing local profiles are preserved.\n');
  }
} catch {process.stderr.write('Could not confirm demo shutdown. Check its original terminal; no unrelated process was killed.\n'); process.exitCode = 1;}
