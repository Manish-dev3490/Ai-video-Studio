import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readDurationEvidence} from '../projects/duration-evidence.js';

// Internal child protocol only. No network provider/API/database credentials are
// passed into the renderer. A native process-job gate precedes every execution.
const [requestFile, gateFile] = process.argv.slice(2);
const sleeping = new Int32Array(new SharedArrayBuffer(4));
function waitFor(file, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw Object.assign(new Error('The controlled renderer did not receive permission to continue.'), {code: 'RENDER_HANDSHAKE_TIMEOUT'});
    Atomics.wait(sleeping, 0, 0, 25);
  }
}

async function main() {
  if (!requestFile || !gateFile || !path.isAbsolute(requestFile) || !path.isAbsolute(gateFile)) throw new Error('INVALID_INTERNAL_REQUEST');
  waitFor(gateFile, 20);
  const request = JSON.parse(await fsp.readFile(requestFile, 'utf8'));
  const engine = await import(pathToFileURL(path.join(request.engineRoot, 'src/index.js')).href);
  const onProgress = event => {
    const occurredAt = new Date().toISOString();
    process.stdout.write(JSON.stringify({...event, occurredAt}) + '\n');
    if (event.stage === 'RENDER_VIDEO' && event.event === 'STAGE_STARTED') waitFor(request.renderGate, 20);
  };
  let result;
  try {result = await engine.renderExplainer({storyboard: request.storyboard, outputDir: request.outputDir, modelPath: request.modelPath || engine.DEFAULT_MODEL_PATH, browserExecutable: request.browserExecutable, concurrency: 1, onProgress});}
  catch (error) {
    if (error.code === 'DURATION_REVISION_REQUIRED') error.durationFeedback = await readDurationEvidence({outputDir: request.outputDir, storyboard: request.storyboard, details: error.details});
    throw error;
  }
  if (result.status !== 'COMPLETED' || !result.validation?.passed) throw new Error('OUTPUT_VALIDATION_FAILED');
  process.stdout.write(JSON.stringify({event: 'RENDER_CHILD_COMPLETED', occurredAt: new Date().toISOString()}) + '\n');
}
main().catch(error => {
  const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'LOCAL_RENDER_FAILED';
  process.stderr.write(JSON.stringify({code, message: 'The isolated local render did not complete.', ...(code === 'DURATION_REVISION_REQUIRED' && error.durationFeedback ? {durationFeedback: error.durationFeedback} : {})}) + '\n');
  process.exitCode = 1;
});
