import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sanitizeDurationEvidence} from '../projects/duration-feedback.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let powershell = process.env.POWERSHELL_EXECUTABLE || 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
export function configureProcessControl(config) {if (config.powershellExecutable) powershell = config.powershellExecutable;}
export const hostId = os.hostname().replace(/[^a-zA-Z0-9_.-]/gu, '_');
const run = args => new Promise((resolve, reject) => execFile(powershell, args, {windowsHide: true, maxBuffer: 128000, timeout: 20000}, (error, stdout) => error ? reject(Object.assign(new Error('Owned execution could not be confirmed stopped.'), {code: 'PROCESS_STOP_UNCONFIRMED'})) : resolve(stdout)));
export async function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {return (await run(['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`])).trim();}
  catch {return null;}
}
export async function stopControlledJob(jobName) {
  if (!/^AVS-Render-[a-f0-9]{32}$/u.test(jobName)) throw new Error('INVALID_CONTROLLED_JOB');
  await run(['-NoProfile', '-File', path.join(here, 'isolation.ps1'), '-Mode', 'Stop', '-JobName', jobName]);
  return true;
}
export async function assertControlledJobStopped(jobName) {
  await run(['-NoProfile', '-File', path.join(here, 'isolation.ps1'), '-Mode', 'Probe', '-JobName', jobName]);
  return true;
}
export async function acquireWorkerLock(directory) {
  if (process.platform !== 'win32') throw new Error('WORKER_PLATFORM_NOT_VALIDATED');
  await fs.mkdir(directory, {recursive: true});
  const file = path.join(directory, '.worker.lock');
  let recoveredWorkerId = null;
  try {
    const old = JSON.parse(await fs.readFile(file, 'utf8'));
    if (old.hostId !== hostId) throw new Error('WORKER_HOST_MISMATCH');
    const existingIdentity = await processStartIdentity(old.pid);
    if (existingIdentity && existingIdentity === old.startIdentity) throw new Error('WORKER_ALREADY_RUNNING');
    // A named native job survives a parent crash only while it still has live
    // handles/processes. Stop/query this exact random job, never a reused PID.
    if (old.controlledJobName) await stopControlledJob(old.controlledJobName);
    recoveredWorkerId = old.workerId;
    await fs.unlink(file);
  } catch (error) {if (error.code !== 'ENOENT') throw error;}
  const state = {hostId, pid: process.pid, startIdentity: await processStartIdentity(process.pid), workerId: `${hostId}:${process.pid}:${randomUUID()}`, controlledJobName: null};
  if (!state.startIdentity) throw new Error('WORKER_IDENTITY_UNAVAILABLE');
  await fs.writeFile(file, JSON.stringify(state), {flag: 'wx'});
  return {
    state,
    recoveredWorkerId,
    async setExecution(controlledJobName) {state.controlledJobName = controlledJobName; const next = file + '.next'; await fs.writeFile(next, JSON.stringify(state)); await fs.rename(next, file);},
    async release() {
      if (state.controlledJobName) await stopControlledJob(state.controlledJobName);
      const actual = JSON.parse(await fs.readFile(file, 'utf8'));
      if (actual.workerId !== state.workerId) throw new Error('WORKER_LOCK_LOST');
      await fs.unlink(file);
    },
  };
}

function rendererEnvironment() {
  const result = {NODE_ENV: 'production'};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[name]) result[name] = process.env[name];
  return result;
}

export async function startControlledRender({attemptDirectory, config, storyboard, onProgress, onRegistered, parentStartIdentity}) {
  const jobName = 'AVS-Render-' + randomUUID().replaceAll('-', '');
  const gateFile = path.join(attemptDirectory, 'isolation.ready');
  const renderGate = path.join(attemptDirectory, 'render.ready');
  const outputDir = path.join(attemptDirectory, 'render');
  const requestFile = path.join(attemptDirectory, 'request.json');
  await fs.mkdir(attemptDirectory, {recursive: true});
  await fs.writeFile(requestFile, JSON.stringify({storyboard, engineRoot: config.engineRoot, outputDir, renderGate, browserExecutable: config.browserExecutable, ...(config.kokoroModelPath ? {modelPath: config.kokoroModelPath} : {})}), {flag: 'wx'});
  await onRegistered(jobName);
  const parentIdentity = parentStartIdentity || await processStartIdentity(process.pid);
  if (!parentIdentity) throw new Error('WORKER_IDENTITY_UNAVAILABLE');
  const child = spawn(powershell, ['-NoProfile', '-File', path.join(here, 'isolation.ps1'), '-Mode', 'Run', '-JobName', jobName, '-NodeExecutable', process.execPath, '-Runner', path.join(here, 'runner.js'), '-RequestFile', requestFile, '-GateFile', gateFile, '-ParentPid', String(process.pid), '-ParentStartIdentity', parentIdentity], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: rendererEnvironment()});
  let pending = '', errors = '', chain = Promise.resolve(), progressFailure;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending = (pending + chunk).slice(-64000);
    const lines = pending.split(/\r?\n/u); pending = lines.pop();
    for (const line of lines) {
      let event;
      try {event = JSON.parse(line);} catch {continue;}
      chain = chain.then(async () => {
        await onProgress(event);
        if (event.stage === 'RENDER_VIDEO' && event.event === 'STAGE_STARTED') await fs.writeFile(renderGate, 'ready', {flag: 'wx'});
      }).catch(error => {progressFailure = error;});
    }
  });
  child.stderr.on('data', chunk => {errors = (errors + chunk).slice(-64000);});
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => reject(Object.assign(new Error('The isolated renderer could not start.'), {code: 'RENDER_CHILD_FAILED'})));
    child.once('close', async (code, signal) => {
      try {
        await chain;
        await stopControlledJob(jobName);
        if (progressFailure) throw progressFailure;
        if (code !== 0 || signal) {
          let errorCode = 'LOCAL_RENDER_FAILED';
          let durationFeedback;
          for (const line of errors.trim().split(/\r?\n/u).reverse()) {try {const value = JSON.parse(line); if (/^[A-Z0-9_]{1,80}$/u.test(value.code || '')) {errorCode = value.code; if (errorCode === 'DURATION_REVISION_REQUIRED') durationFeedback = sanitizeDurationEvidence(value.durationFeedback, storyboard); break;}} catch {}}
          throw Object.assign(new Error('The isolated local video render failed.'), {code: errorCode, ...(durationFeedback ? {durationFeedback} : {})});
        }
        resolve({outputDir});
      } catch (error) {reject(error);}
    });
  });
  // Install a handler immediately; callers await after their monitor is ready.
  completion.catch(() => {});
  return {jobName, child, outputDir, completion, async stop() {await stopControlledJob(jobName); for (let count = 0; count < 100 && child.exitCode === null; count++) await pause(50); if (child.exitCode === null) throw Object.assign(new Error('The renderer stop is not confirmed.'), {code: 'PROCESS_STOP_UNCONFIRMED'});}};
}
