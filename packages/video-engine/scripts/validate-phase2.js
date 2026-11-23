import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {DEFAULT_BROWSER_EXECUTABLE, hashApprovedStoryboard, renderExplainer, renderPrepared} from '../src/index.js';
import {readJson, sha256File, writeJson} from '../src/media.js';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
const exists = file => fs.access(file).then(() => true, () => false);

function argumentsFor(argv) {
  const options = {only: [30, 60, 90], resume: false};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--resume') options.resume = true;
    else if (flag === '--help') options.help = true;
    else if (['--output-root', '--browser', '--model-dir', '--only'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      if (flag === '--only') {
        const values = value.split(',').map(Number);
        if (!values.length || new Set(values).size !== values.length || values.some(item => ![30, 60, 90].includes(item))) throw new Error('INVALID_ARGUMENTS');
        options.only = values;
      } else options[{'--output-root': 'outputRoot', '--browser': 'browserExecutable', '--model-dir': 'modelPath'}[flag]] = path.resolve(value);
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (!options.help && !options.outputRoot) throw new Error('INVALID_ARGUMENTS');
  return options;
}

async function verifyCompleted(directory, storyboard) {
  const result = await readJson(path.join(directory, 'result.json'));
  const publication = await readJson(path.join(directory, 'published-export-manifest.json'));
  if (result.status !== 'COMPLETED' || result.validation?.passed !== true || result.storyboardHash !== hashApprovedStoryboard(storyboard)) throw new Error('EXISTING_RESULT_MISMATCH');
  if (await sha256File(path.join(directory, 'video.mp4')) !== publication.videoArtifact.sha256 || await sha256File(path.join(directory, 'captions.vtt')) !== publication.captionArtifact.sha256) throw new Error('EXISTING_RESULT_MISMATCH');
  return result;
}

export async function validateProfiles(options) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const records = [];
  for (const target of options.only) {
    const storyboard = await readJson(path.join(engineRoot, 'fixtures', `event-loop-${target}.json`));
    const outputDir = path.join(options.outputRoot, String(target));
    const onProgress = event => process.stdout.write(JSON.stringify({targetSeconds: target, ...event}) + '\n');
    let result;
    let reusedCompletedResult = false;
    if (await exists(outputDir)) {
      if (!options.resume) throw new Error('OUTPUT_DIRECTORY_EXISTS');
      if (await exists(path.join(outputDir, 'result.json'))) {
        result = await verifyCompleted(outputDir, storyboard);
        reusedCompletedResult = true;
      } else {
        const preparation = await readJson(path.join(outputDir, 'preparation.json'));
        if (preparation.storyboardHash !== hashApprovedStoryboard(storyboard)) throw new Error('PREPARATION_INPUT_MISMATCH');
        result = await renderPrepared({...options, outputDir, onProgress});
      }
    } else result = await renderExplainer({...options, storyboard, outputDir, onProgress});
    const durationSeconds = result.timeline.durationInFrames / result.timeline.fps;
    records.push({targetSeconds: target, actualDurationSeconds: durationSeconds, deltaSeconds: durationSeconds - target, sceneCount: storyboard.scenes.length, storyboardRevision: storyboard.revision, storyboardHash: result.storyboardHash, outputDir, videoPath: result.videoPath, captionPath: result.captionPath, videoBytes: (await fs.stat(result.videoPath)).size, videoSha256: await sha256File(result.videoPath), captionSha256: await sha256File(result.captionPath), checks: result.validation.checks, validationPassed: result.validation.passed, timings: result.timings, reusedCompletedResult});
    process.stdout.write(JSON.stringify({event: 'PROFILE_COMPLETED', targetSeconds: target, actualDurationSeconds: durationSeconds, validationPassed: result.validation.passed}) + '\n');
  }
  const report = {reportVersion: 1, executionMode: 'LOCAL_QA', startedAt, completedAt: new Date().toISOString(), invocationSeconds: (performance.now() - started) / 1000, host: {platform: process.platform, release: os.release(), arch: process.arch, nodeVersion: process.version, cpuModel: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytesAtReport: os.freemem()}, sequential: true, concurrency: 1, browserExecutable: options.browserExecutable || DEFAULT_BROWSER_EXECUTABLE, profiles: records, passed: records.every(record => record.validationPassed && Math.abs(record.deltaSeconds) <= 5), limitations: ['Timings are observed single-run measurements on this host, not capacity guarantees.', 'Completed results resumed by this command are checksum-checked; their original full validation is retained.', 'No authentication, database, durable queue, cancellation or automatic retention service is implemented.']};
  const reportPath = path.join(options.outputRoot, 'benchmark-' + Date.now() + '.json');
  await writeJson(reportPath, report);
  process.stdout.write(JSON.stringify({event: 'PHASE2_VALIDATION_COMPLETED', passed: report.passed, reportPath}) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) return process.stdout.write('node scripts/validate-phase2.js --output-root <directory> [--only 30,60,90] [--resume] [--browser <installed-chrome>] [--model-dir <local-model>]\n');
    return validateProfiles(options);
  }).catch(error => {
    const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'PHASE2_VALIDATION_FAILED';
    process.stderr.write(JSON.stringify({code, message: error.name === 'EngineContractError' ? error.message : 'Phase 2 validation stopped. Preserve failed evidence and select a fresh output directory or a verified prepared run.'}) + '\n');
    process.exitCode = 1;
  });
}
