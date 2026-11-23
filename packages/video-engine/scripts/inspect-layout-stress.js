import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {canonicalHash, validateTimeline} from '../src/contracts.js';
import {assertRenderProps} from '../src/remotion/layout.js';
import {sha256File, writeJson} from '../src/media.js';
import {createMontage, createOutput, observeBounds, sourceRun} from './inspect-visuals.js';

const defaultBrowser = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined;
const usage = 'node scripts/inspect-layout-stress.js --run-dir <completed-run-with-all-five-templates> [--output-dir <fresh-engine-var-visual-qa-directory>] [--browser <installed-chrome>]';
const templates = ['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS'];

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const key = {'--run-dir': 'runDirectory', '--output-dir': 'outputDir', '--browser': 'browserExecutable', '--help': 'help'}[flag];
    if (!key || Object.hasOwn(options, key)) throw new Error('INVALID_ARGUMENTS');
    if (key === 'help') options.help = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      options[key] = path.resolve(value);
    }
  }
  if (!options.help && !options.runDirectory) throw new Error('INVALID_ARGUMENTS');
  return options;
}

function label(length, kind, index = 0) {
  const prefix = String(index + 1).padStart(2, '0');
  const fill = kind === 'newlines' ? 'W\n' : 'W';
  return prefix + fill.repeat(length).slice(0, length - prefix.length);
}

/** Synthetic renderer fixtures only: never synthesis input or new approval. */
export function layoutStressCases(sourceProps) {
  if (templates.some(template => !sourceProps.storyboard.scenes.some(scene => scene.template === template))) throw new Error('SOURCE_TEMPLATE_COVERAGE_INCOMPLETE');
  const result = [];
  for (const kind of ['wide', 'newlines']) {
    const inputProps = structuredClone(sourceProps);
    for (const scene of inputProps.storyboard.scenes) {
      const title = label(120, kind);
      switch (scene.template) {
        case 'TITLE': scene.visualProps = {title, subtitle: label(240, kind)}; break;
        case 'STEPS': scene.visualProps = {title, steps: Array.from({length: 8}, (_, index) => label(240, kind, index))}; break;
        case 'KEY_POINTS': scene.visualProps = {title, points: Array.from({length: 8}, (_, index) => label(240, kind, index))}; break;
        case 'STACK_QUEUE': scene.visualProps = {title, items: Array.from({length: 12}, (_, index) => label(100, kind, index)), layout: 'STACK_AND_QUEUE'}; break;
        case 'FLOWCHART': {
          const nodes = Array.from({length: 12}, (_, index) => ({id: `stress_${index}`, label: label(100, kind, index)}));
          const edges = nodes.slice(0, -1).map((node, index) => ({from: node.id, to: nodes[index + 1].id, label: label(100, kind, index)}));
          edges.push({from: nodes[11].id, to: nodes[0].id, label: label(100, kind, 11)});
          edges.push({from: nodes[0].id, to: nodes[0].id, label: label(100, kind, 12)});
          for (let index = 1; index <= 5; index++) edges.push({from: nodes[index].id, to: nodes[index + 6].id, label: label(100, kind, index + 12)});
          scene.visualProps = {title, nodes, edges};
          break;
        }
        default: throw new Error('UNSUPPORTED_STRESS_TEMPLATE');
      }
    }
    validateTimeline(inputProps.storyboard, inputProps.timeline);
    assertRenderProps(inputProps);
    result.push({id: kind, kind, inputProps, onlyStackQueue: false});
  }
  for (const mode of ['STACK', 'QUEUE']) {
    const inputProps = structuredClone(result[0].inputProps);
    for (const scene of inputProps.storyboard.scenes) if (scene.template === 'STACK_QUEUE') scene.visualProps.layout = mode;
    validateTimeline(inputProps.storyboard, inputProps.timeline);
    assertRenderProps(inputProps);
    result.push({id: mode.toLowerCase(), kind: 'wide', inputProps, onlyStackQueue: true});
  }
  return result;
}

export function stressSamples(testCase) {
  const {storyboard, timeline} = testCase.inputProps;
  return storyboard.scenes.flatMap((scene, index) => {
    if (testCase.onlyStackQueue && scene.template !== 'STACK_QUEUE') return [];
    const timing = timeline.scenes[index];
    let progress = [0.5];
    if (scene.template === 'STEPS' || scene.template === 'KEY_POINTS') progress = [0.25, 0.75];
    if (scene.template === 'STACK_QUEUE') progress = [0.18, 0.84];
    if (scene.template === 'FLOWCHART' && testCase.kind === 'wide') progress = [0.5, 12.5 / 18];
    return progress.map(value => {
      const frame = timing.startFrame + Math.min(timing.durationInFrames - 1, Math.floor(value * timing.durationInFrames));
      return {caseId: testCase.id, kind: testCase.kind, sceneId: scene.sceneId, template: scene.template, ...(scene.template === 'STACK_QUEUE' ? {layout: scene.visualProps.layout} : {}), frame, sceneProgress: (frame - timing.startFrame + 1) / timing.durationInFrames};
    });
  });
}

export async function inspectLayoutStress(options) {
  const browserExecutable = options.browserExecutable || defaultBrowser;
  if (!browserExecutable || !path.isAbsolute(browserExecutable)) throw new Error('BROWSER_REQUIRED');
  await fs.access(browserExecutable);
  const run = await sourceRun(options.runDirectory);
  const cases = layoutStressCases(run.inputProps);
  const originalInputHash = canonicalHash(run.inputProps);
  const outputDir = await createOutput(options.outputDir);
  const fixtures = [];
  for (const testCase of cases) {
    const file = path.join(outputDir, `synthetic-input-props-${testCase.id}.json`);
    await writeJson(file, testCase.inputProps);
    fixtures.push({caseId: testCase.id, file, sha256: await sha256File(file), syntheticInputHash: canonicalHash(testCase.inputProps)});
  }
  // Keep a clear warning beside canonical-shaped fixtures. The inherited
  // APPROVED flag only exercises the renderer gate; this creates no approval.
  await writeJson(path.join(outputDir, 'fixture-scope.json'), {executionMode: 'SYNTHETIC_LAYOUT_QA', sourceRun: run.directory, sourceStoryboardHash: run.preparation.storyboardHash, sourceBundleSha256: run.bundleSha256, changedFields: ['storyboard.scenes[*].visualProps'], inheritedFields: ['source narration', 'measured timeline', 'scene IDs', 'audioSources', 'original fixture approval metadata'], createsApproval: false, synthesisPerformed: false, mp4Rendered: false, explanation: 'These trusted test cases are not product generation inputs or approved user revisions. The source run is read-only; narration and timing are reused solely for still composition.'});
  const samples = [];
  let browser;
  try {
    browser = await openBrowser('chrome', {browserExecutable, chromiumOptions: {headless: true}, logLevel: 'error'});
    for (const testCase of cases) {
      const {timeline} = testCase.inputProps;
      const composition = await selectComposition({serveUrl: run.bundleDirectory, id: 'ExplainerVideo', inputProps: testCase.inputProps, browserExecutable, puppeteerInstance: browser, logLevel: 'error'});
      if (composition.width !== 1280 || composition.height !== 720 || composition.fps !== 30 || composition.durationInFrames !== timeline.durationInFrames) throw new Error('COMPOSITION_METADATA_MISMATCH');
      for (const sample of stressSamples(testCase)) {
        const image = path.join(outputDir, `frame-${String(samples.length).padStart(3, '0')}.png`);
        const state = {finished: false};
        const rendering = renderStill({serveUrl: run.bundleDirectory, composition, inputProps: testCase.inputProps, frame: sample.frame, output: image, imageFormat: 'png', overwrite: false, browserExecutable, puppeteerInstance: browser, scale: 1, logLevel: 'error', onBrowserDownload: () => { throw new Error('BROWSER_DOWNLOAD_DISABLED'); }}).finally(() => { state.finished = true; });
        const expected = {sceneId: sample.sceneId, progress: timeline.scenes.map(timing => Math.min(1, Math.max(0, (sample.frame - timing.startFrame + 1) / timing.durationInFrames)))};
        const [, bounds] = await Promise.all([rendering, observeBounds(browser, expected, state)]);
        samples.push({...sample, image, sha256: await sha256File(image), bounds});
        process.stdout.write(JSON.stringify({event: 'STRESS_FRAME_CAPTURED', caseId: sample.caseId, sceneId: sample.sceneId, template: sample.template, frame: sample.frame, boundsCaptured: bounds.captured, overflowCount: bounds.violations?.length ?? null, image}) + '\n');
      }
    }
  } finally { if (browser) await browser.close({silent: true}); }
  if (canonicalHash(run.inputProps) !== originalInputHash) throw new Error('SOURCE_RUN_MUTATED');
  const montage = await createMontage(outputDir, samples);
  const captured = samples.filter(sample => sample.bounds.captured);
  const violations = captured.flatMap(sample => sample.bounds.violations.map(violation => ({caseId: sample.caseId, sceneId: sample.sceneId, frame: sample.frame, ...violation})));
  const passed = captured.length === samples.length && violations.length === 0;
  const report = {reportVersion: 1, executionMode: 'SYNTHETIC_LAYOUT_QA', createdAt: new Date().toISOString(), sourceRun: run.directory, sourceBundleSha256: run.bundleSha256, originalInputHash, sourceInputUnchanged: canonicalHash(run.inputProps) === originalInputHash, sourceApprovalReusedForProduction: false, synthesisPerformed: false, mp4Rendered: false, outputDir, montage, fixtures, coverage: {titleCodePoints: 120, subtitleCodePoints: 240, steps: 8, points: 8, listEntryCodePoints: 240, stackQueueItems: 12, stackQueueItemCodePoints: 100, flowNodes: 12, flowEdges: 18, flowLabelCodePoints: 100, kinds: ['wide', 'newlines'], stackQueueLayouts: ['STACK', 'QUEUE', 'STACK_AND_QUEUE'], selfLoop: true}, samples, domBounds: {captured: captured.length, total: samples.length, violations, passed}, limitations: ['Synthetic canonical-shaped visual fixtures exercise bounds, not storyboard/narration semantic consistency.', 'Human inspection of full-resolution PNGs is still required for legibility and diagram quality.', 'No text-to-speech, MP4 or new approved user revision is generated.', 'Missing DOM observations count as incomplete; no unseen frame is treated as passing.']};
  const reportPath = path.join(outputDir, 'layout-stress-qa.json');
  await writeJson(reportPath, report);
  process.stdout.write(JSON.stringify({event: 'LAYOUT_STRESS_QA_COMPLETED', reportPath, montage, frames: samples.length, boundsPassed: passed}) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) return process.stdout.write(usage + '\n');
    return inspectLayoutStress(options);
  }).catch(error => {
    const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'LAYOUT_STRESS_QA_FAILED';
    process.stderr.write(JSON.stringify({code, message: code === 'INVALID_ARGUMENTS' ? usage : 'Layout stress QA stopped. Preserve the source run and partial QA evidence.'}) + '\n');
    process.exitCode = 1;
  });
}
