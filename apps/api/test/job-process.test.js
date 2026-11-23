import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {stopControlledJob, assertControlledJobStopped, processStartIdentity} from '../src/jobs/process-control.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('native Windows job termination confirms the renderer and grandchild are stopped', {skip: process.platform !== 'win32', timeout: 45000}, async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = path.join(repo, 'var', 'job-process-test-' + randomUUID());
  await fs.mkdir(directory, {recursive: true});
  const jobName = 'AVS-Render-' + randomUUID().replaceAll('-', '');
  const script = path.join(directory, 'pulse.mjs'), request = path.join(directory, 'pulse.json'), gate = path.join(directory, 'gate.ready');
  await fs.writeFile(script, `import fs from 'node:fs';import{spawn}from'node:child_process';const [output,gate]=process.argv.slice(2);const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(gate))Atomics.wait(wait,0,0,10);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(output,JSON.stringify({pid:process.pid,childPid:child.pid}));setInterval(()=>{},1000);`);
  const pwsh = process.env.POWERSHELL_EXECUTABLE || 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
  const helper = path.join(repo, 'apps/api/src/jobs/isolation.ps1');
  const wrapper = spawn(pwsh, ['-NoProfile', '-File', helper, '-Mode', 'Run', '-JobName', jobName, '-NodeExecutable', process.execPath, '-Runner', script, '-RequestFile', request, '-GateFile', gate, '-ParentPid', String(process.pid), '-ParentStartIdentity', await processStartIdentity(process.pid)], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  wrapper.stderr.on('data', value => {stderr += value;});
  const exited = new Promise(resolve => wrapper.once('exit', resolve));
  try {
    let ready = false;
    for (let count = 0; count < 100; count++) {
      try {await fs.access(request); ready = true; break;} catch {}
      if (wrapper.exitCode !== null) break;
      await pause(50);
    }
    assert.ok(ready, 'The gated process and descendant start inside the native job: ' + stderr.slice(-500));
    const identities = JSON.parse(await fs.readFile(request, 'utf8'));
    const originalStarts = await Promise.all([identities.pid, identities.childPid].map(processStartIdentity));
    assert.ok(originalStarts.every(Boolean), 'Both owned process identities are recorded before termination');
    assert.equal(await stopControlledJob(jobName), true);
    await exited;
    assert.equal(await assertControlledJobStopped(jobName), true);
    // Windows can reuse a PID while other test processes are starting. Verify
    // the original process identity, as the worker itself does, rather than
    // asserting that no later unrelated process can ever have the same PID.
    for (const [index, pid] of [identities.pid, identities.childPid].entries()) assert.notEqual(await processStartIdentity(pid), originalStarts[index], 'The original owned process no longer exists');
  } finally {
    await stopControlledJob(jobName).catch(() => {});
    if (wrapper.exitCode === null) wrapper.kill();
    assert.ok(path.resolve(directory).startsWith(path.resolve(repo, 'var') + path.sep));
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('abrupt controller death stops the native renderer tree without waiting for a replacement worker', {skip: process.platform !== 'win32', timeout: 30000}, async () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = path.join(repo, 'var', 'job-process-test-' + randomUUID());
  await fs.mkdir(directory, {recursive: true});
  const jobName = 'AVS-Render-' + randomUUID().replaceAll('-', '');
  const script = path.join(directory, 'pulse.mjs'), request = path.join(directory, 'pulse.json'), gate = path.join(directory, 'gate.ready');
  const controllerFile = path.join(directory, 'controller.mjs'), helperLog = path.join(directory, 'helper.log');
  await fs.writeFile(script, `import fs from 'node:fs';import{spawn}from'node:child_process';const [output,gate]=process.argv.slice(2);const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(gate))Atomics.wait(wait,0,0,10);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(output,JSON.stringify({pid:process.pid,childPid:child.pid}));setInterval(()=>{},1000);`);
  await fs.writeFile(controllerFile, `import fs from 'node:fs';import{spawn}from'node:child_process';import{pathToFileURL}from'node:url';const [controlModule,pwsh,helper,script,request,gate,name,log]=process.argv.slice(2);const {processStartIdentity}=await import(pathToFileURL(controlModule).href);const identity=await processStartIdentity(process.pid);const handle=fs.openSync(log,'a');spawn(pwsh,['-NoProfile','-File',helper,'-Mode','Run','-JobName',name,'-NodeExecutable',process.execPath,'-Runner',script,'-RequestFile',request,'-GateFile',gate,'-ParentPid',String(process.pid),'-ParentStartIdentity',identity],{windowsHide:true,stdio:['ignore',handle,handle]});setInterval(()=>{},1000);`);
  const pwsh = process.env.POWERSHELL_EXECUTABLE || 'C:/Users/manish kumar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
  const helper = path.join(repo, 'apps/api/src/jobs/isolation.ps1');
  const controlModule = path.join(repo, 'apps/api/src/jobs/process-control.js');
  const controller = spawn(process.execPath, [controllerFile, controlModule, pwsh, helper, script, request, gate, jobName, helperLog], {windowsHide: true, stdio: 'ignore'});
  try {
    let identities;
    for (let count = 0; count < 150; count++) {
      try {identities = JSON.parse(await fs.readFile(request, 'utf8')); break;} catch {}
      if (controller.exitCode !== null) break;
      await pause(50);
    }
    assert.ok(identities, 'Controlled tree was running before the controller crash');
    controller.kill(); // Only this test-owned parent; its helper is left alive.
    let stopped = false;
    for (let count = 0; count < 100; count++) {
      try {process.kill(identities.pid, 0);} catch {stopped = true; break;}
      await pause(50);
    }
    assert.equal(stopped, true, 'The surviving helper detects parent death and stops the renderer');
    assert.equal(await assertControlledJobStopped(jobName), true);
    assert.throws(() => process.kill(identities.childPid, 0), 'The renderer grandchild is stopped too');
  } finally {
    await stopControlledJob(jobName).catch(() => {});
    if (controller.exitCode === null) controller.kill();
    assert.ok(path.resolve(directory).startsWith(path.resolve(repo, 'var') + path.sep));
    // The orphan helper can be finishing its redirected logfile after the job
    // processes exit. Wait before removing only this test-owned directory.
    for (let count = 0; count < 30; count++) {
      try {await fs.rm(directory, {recursive: true, force: true}); break;} catch (error) {if (!['EBUSY', 'EPERM'].includes(error.code)) throw error; await pause(100);}
    }
  }
});
