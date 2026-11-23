import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {canonicalHash, validateTimeline} from '../packages/video-engine/src/contracts.js';
import {sourceRun, observeBounds, createMontage} from '../packages/video-engine/scripts/inspect-visuals.js';
import {assertVisualDensity} from '../apps/api/src/projects/validation.js';

const require = createRequire(new URL('../packages/video-engine/package.json', import.meta.url));
const {openBrowser, renderStill, selectComposition} = require('@remotion/renderer');
const root = fileURLToPath(new URL('../', import.meta.url));
const browserExecutable = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const source = await sourceRun(path.join(root, 'artifacts/phase2/accepted/90'));
const sourceHash = canonicalHash(source.inputProps);
const output = path.join(root, 'artifacts/phase8', 'visual-quality-' + Date.now());
await fs.mkdir(output, {recursive: true});
const label = (maximum, kind) => (kind === 'newlines' ? 'W\n'.repeat(maximum) : ('W'.repeat(20) + ' ').repeat(maximum)).slice(0, maximum).trim();
const rejections = [];
function acceptedFixture(storyboard, caseId) {
  // Search only synthetic QA labels; never rewrite or silently trim user input.
  for (let attempts = 0; attempts < 4000; attempts++) {
    try {assertVisualDensity(storyboard); return;}
    catch (error) {
      const field = error.details?.field;
      if (error.code !== 'LAYOUT_REVIEW_REQUIRED' || !field) throw error;
      rejections.push({caseId, field, code: error.code});
      const parts = field.match(/[A-Za-z_]+|\d+/gu);
      let parent = storyboard;
      for (const part of parts.slice(0, -1)) parent = parent[part];
      const key = parts.at(-1);
      if (typeof parent[key] !== 'string' || parent[key].length < 2) throw error;
      parent[key] = parent[key].slice(0, -1).trimEnd();
    }
  }
  throw new Error('No bounded visual fixture could be constructed.');
}
function fixture(kind, mode = 'STACK_AND_QUEUE', onlyStructures = false) {
  const inputProps = structuredClone(source.inputProps);
  for (const scene of inputProps.storyboard.scenes) {
    const title = label(70, kind);
    switch (scene.template) {
      case 'TITLE': scene.visualProps = {title, subtitle: label(180, kind)}; break;
      case 'STEPS': scene.visualProps = {title, steps: Array.from({length: 8}, () => label(180, kind))}; break;
      case 'KEY_POINTS': scene.visualProps = {title, points: Array.from({length: 8}, () => label(180, kind))}; break;
      case 'STACK_QUEUE': scene.visualProps = {title, items: Array.from({length: 12}, () => label(80, kind)), layout: mode}; break;
      case 'FLOWCHART': {
        const nodes = Array.from({length: 4}, (_, index) => ({id: 'quality_' + index, label: label(60, kind)}));
        const edges = nodes.slice(0, -1).map((node, index) => ({from: node.id, to: nodes[index + 1].id, label: label(60, kind)}));
        scene.visualProps = {title, nodes, edges}; break;
      }
      default: throw new Error('Unexpected template');
    }
  }
  acceptedFixture(inputProps.storyboard, kind + '-' + mode); validateTimeline(inputProps.storyboard, inputProps.timeline);
  return {id: onlyStructures ? mode.toLowerCase() : kind, kind, onlyStructures, inputProps};
}
const cases = [fixture('wide'), fixture('newlines'), fixture('wide', 'STACK', true), fixture('wide', 'QUEUE', true)];
const report = {mode: 'SYNTHETIC_ACCEPTED_DENSITY_STILL_QA', startedAt: new Date().toISOString(), sourceRun: source.directory, sourceBundleSha256: source.bundleSha256, sourceUnchanged: false, createsApproval: false, synthesizedAudio: false, renderedMp4: false, rejectedWideLabelCandidates: rejections.length, rejectedFields: [...new Set(rejections.map(value => value.field))], samples: [], passed: false};
await fs.writeFile(path.join(output, 'fixture-scope.json'), JSON.stringify({mode: report.mode, changedFields: ['storyboard.scenes[*].visualProps'], inheritedFields: ['approved test-fixture metadata', 'narration', 'timeline', 'audioSources'], createsApproval: false, servesProduction: false, maxDensity: {title: 70, subtitle: 180, cards: 8, cardLabel: 180, stackItems: 12, stackItemLabel: 80, flowNodes: 4, flowNodeLabel: 60, flowEdgeLabel: 60, maximumUnbrokenWord: 40}, explanation: 'Trusted still-only test fixtures exercise the existing renderer at the API accepted density bounds. No user approval, TTS synthesis or MP4 generation is performed.'}, null, 2));
let browser;
try {
  browser = await openBrowser('chrome', {browserExecutable, chromiumOptions: {headless: true}, logLevel: 'error'});
  for (const testCase of cases) {
    const {storyboard, timeline} = testCase.inputProps;
    const composition = await selectComposition({serveUrl: source.bundleDirectory, id: 'ExplainerVideo', inputProps: testCase.inputProps, browserExecutable, puppeteerInstance: browser, logLevel: 'error'});
    for (const [index, scene] of storyboard.scenes.entries()) {
      if (testCase.onlyStructures && scene.template !== 'STACK_QUEUE') continue;
      const timing = timeline.scenes[index];
      const progressSamples = ['STEPS', 'KEY_POINTS'].includes(scene.template) ? [0.25, 0.75] : scene.template === 'STACK_QUEUE' ? [0.18, 0.84] : scene.template === 'FLOWCHART' ? [0.17, 0.83] : [0.5];
      for (const progress of progressSamples) {
        const frame = timing.startFrame + Math.min(timing.durationInFrames - 1, Math.floor(progress * timing.durationInFrames));
        const image = path.join(output, `frame-${String(report.samples.length).padStart(3, '0')}.png`);
        const state = {finished: false};
        const rendering = renderStill({serveUrl: source.bundleDirectory, composition, inputProps: testCase.inputProps, frame, output: image, imageFormat: 'png', overwrite: false, browserExecutable, puppeteerInstance: browser, scale: 1, logLevel: 'error', onBrowserDownload: () => {throw new Error('BROWSER_DOWNLOAD_DISABLED');}}).finally(() => {state.finished = true;});
        const expected = {sceneId: scene.sceneId, progress: timeline.scenes.map(value => Math.min(1, Math.max(0, (frame - value.startFrame + 1) / value.durationInFrames)))};
        const [, bounds] = await Promise.all([rendering, observeBounds(browser, expected, state)]);
        report.samples.push({caseId: testCase.id, sceneId: scene.sceneId, template: scene.template, frame, image, bounds});
        process.stdout.write(JSON.stringify({event: 'PHASE8_VISUAL_FRAME', caseId: testCase.id, template: scene.template, captured: bounds.captured, violations: bounds.violations?.length ?? null}) + '\n');
      }
    }
  }
  report.sourceUnchanged = sourceHash === canonicalHash(source.inputProps);
  report.montage = await createMontage(output, report.samples);
  report.passed = report.sourceUnchanged && report.samples.every(sample => sample.bounds.captured && sample.bounds.violations.length === 0);
} catch (error) {report.failure = String(error.message).slice(0, 1000);}
finally {
  if (browser) await browser.close({silent: true});
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({event: 'PHASE8_VISUAL_COMPLETED', passed: report.passed, frames: report.samples.length, report: path.join(output, 'report.json')}) + '\n');
  if (!report.passed) process.exitCode = 1;
}
