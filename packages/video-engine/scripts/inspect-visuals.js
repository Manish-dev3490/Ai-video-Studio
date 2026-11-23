import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {canonicalHash, hashApprovedStoryboard, validateTimeline} from '../src/contracts.js';
import {readJson, sha256File, writeJson} from '../src/media.js';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultBrowser = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined;
const usage = 'node scripts/inspect-visuals.js --run-dir <completed-run> [--run-dir <another-run>] [--output-dir <fresh-engine-var-directory>] [--browser <installed-chrome>] [--dom-bounds]';
const exists = file => fs.access(file).then(() => true, () => false);
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

export function parseVisualArguments(argv) {
  const values = {runDirectories: [], domBounds: false};
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== '--run-dir' && seen.has(flag)) throw new Error('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--help') values.help = true;
    else if (flag === '--dom-bounds') values.domBounds = true;
    else if (['--run-dir', '--output-dir', '--browser'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
      const resolved = path.resolve(value);
      if (flag === '--run-dir') values.runDirectories.push(resolved);
      else values[flag === '--output-dir' ? 'outputDir' : 'browserExecutable'] = resolved;
    } else throw new Error('INVALID_ARGUMENTS');
  }
  if (!values.help && (!values.runDirectories.length || new Set(values.runDirectories).size !== values.runDirectories.length)) throw new Error('INVALID_ARGUMENTS');
  return values;
}

export function sceneSamples(storyboard, timeline) {
  return storyboard.scenes.flatMap((scene, index) => {
    const timing = timeline.scenes[index];
    let progress = [0.5];
    if (scene.template === 'STACK_QUEUE') progress = [0.18, 0.5, 0.84];
    else if ((scene.visualProps.steps || scene.visualProps.points || []).length > 4 || (scene.template === 'FLOWCHART' && scene.visualProps.edges.length > 1)) progress = [0.25, 0.75];
    return [...new Set(progress.map(value => timing.startFrame + Math.min(timing.durationInFrames - 1, Math.floor(value * timing.durationInFrames))))]
      .map(frame => ({sceneId: scene.sceneId, template: scene.template, ...(scene.template === 'STACK_QUEUE' ? {layout: scene.visualProps.layout || 'STACK'} : {}), frame, sceneProgress: (frame - timing.startFrame + 1) / timing.durationInFrames}));
  });
}

async function fingerprint(directory) {
  const files = [];
  const walk = async relative => {
    for (const entry of (await fs.readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('BUNDLE_INTEGRITY_FAILED');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push({file: name.split(path.sep).join('/'), sha256: await sha256File(path.join(directory, name))});
      else throw new Error('BUNDLE_INTEGRITY_FAILED');
    }
  };
  await walk('');
  return canonicalHash(files);
}

export async function sourceRun(input) {
  const directory = await fs.realpath(input);
  if (await exists(path.join(directory, 'render.lock'))) throw new Error('RENDER_STILL_RUNNING');
  const result = await readJson(path.join(directory, 'result.json'));
  const preparation = await readJson(path.join(directory, 'preparation.json'));
  const publication = await readJson(path.join(directory, 'published-export-manifest.json'));
  const inputProps = await readJson(path.join(directory, 'input-props.json'));
  const {storyboard, timeline} = inputProps;
  validateTimeline(storyboard, timeline);
  if (result.status !== 'COMPLETED' || result.validation?.passed !== true || hashApprovedStoryboard(storyboard) !== preparation.storyboardHash || preparation.storyboardHash !== result.storyboardHash || await sha256File(path.join(directory, 'input-props.json')) !== preparation.inputPropsSha256) throw new Error('SOURCE_RUN_INTEGRITY_FAILED');
  const manifestFile = path.resolve(result.renderManifestPath);
  if (!inside(directory, manifestFile) || !/^render-manifest-[a-f0-9]{32}\.json$/u.test(path.basename(manifestFile))) throw new Error('SOURCE_RUN_INTEGRITY_FAILED');
  const manifest = await readJson(manifestFile);
  if (canonicalHash(manifest) !== publication.renderManifestSha256 || canonicalHash(timeline) !== preparation.timelineSha256 || canonicalHash(timeline) !== canonicalHash(manifest.timeline) || await sha256File(path.join(directory, 'video.mp4')) !== publication.videoArtifact.sha256) throw new Error('SOURCE_RUN_INTEGRITY_FAILED');
  const renderId = path.basename(manifestFile).slice('render-manifest-'.length, -'.json'.length);
  const expectedBundleHash = manifest.provenance.bundleSha256;
  let bundleDirectory;
  for (const candidate of [path.join(directory, 'bundle'), path.join(directory, 'bundle-' + renderId)]) {
    if (await exists(candidate) && await fingerprint(candidate) === expectedBundleHash) { bundleDirectory = candidate; break; }
  }
  if (!bundleDirectory) throw new Error('BUNDLE_INTEGRITY_FAILED');
  return {directory, preparation, inputProps, bundleDirectory, bundleSha256: expectedBundleHash};
}

export async function createOutput(requested) {
  const allowed = path.join(await fs.realpath(engineRoot), 'var', 'visual-qa');
  const directory = requested || path.join(allowed, Date.now() + '-' + randomUUID().slice(0, 8));
  if (!inside(allowed, directory) || directory === allowed) throw new Error('INVALID_VISUAL_OUTPUT_DIRECTORY');
  // Verify the nearest existing ancestor before any recursive mkdir, including
  // an existing junction. QA output can never be redirected into preserved code.
  let ancestor = path.dirname(directory);
  while (!await exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('INVALID_VISUAL_OUTPUT_DIRECTORY');
    ancestor = parent;
  }
  const resolved = path.join(await fs.realpath(ancestor), path.relative(ancestor, directory));
  if (!inside(allowed, resolved) || resolved === allowed) throw new Error('INVALID_VISUAL_OUTPUT_DIRECTORY');
  await fs.mkdir(path.dirname(resolved), {recursive: true});
  await fs.mkdir(resolved);
  return resolved;
}

// Passed to the browser's exposed Page.evaluate method. It only reads existing
// DOM; exact footer progress confirms these measurements belong to this frame.
export function readBrowserBounds(expected) {
  const canvas = document.querySelector('.engine-canvas');
  const scene = document.querySelector('[data-scene-id]');
  const actualProgress = Array.from(document.querySelectorAll('.engine-progress-part > div'), element => Number(element.style.transform.match(/^scaleX\(([^)]+)\)$/u)?.[1]));
  if (!canvas || scene?.dataset.sceneId !== expected.sceneId || document.fonts.status !== 'loaded' || actualProgress.length !== expected.progress.length || actualProgress.some((value, index) => !Number.isFinite(value) || Math.abs(value - expected.progress[index]) > 0.000001)) return null;
  const rect = element => {
    const box = element.getBoundingClientRect();
    return {left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height};
  };
  const boundary = rect(canvas);
  const violations = [];
  const tolerance = 1.5;
  const outside = (inner, outer) => inner.left < outer.left - tolerance || inner.right > outer.right + tolerance || inner.top < outer.top - tolerance || inner.bottom > outer.bottom + tolerance;
  const text = Array.from(scene.querySelectorAll('[data-fit-text]'), (element, index) => {
    const box = rect(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const glyphs = rect(range);
    const style = getComputedStyle(element);
    // Range rectangles include font ascent/descent metrics beyond the CSS line
    // box. Permit only the measured half-leading, keeping scroll/canvas checks.
    const metricHeight = Math.max(0, ...Array.from(range.getClientRects(), value => value.height));
    const metricAllowanceY = Math.max(tolerance, (metricHeight - parseFloat(style.lineHeight)) / 2 + tolerance);
    const textBoundary = {...box, top: box.top - metricAllowanceY, bottom: box.bottom + metricAllowanceY};
    const overflow = element.scrollWidth > element.clientWidth + tolerance || element.scrollHeight > element.clientHeight + tolerance || outside(glyphs, textBoundary) || outside(glyphs, boundary);
    if (overflow) violations.push({type: 'TEXT_OVERFLOW', index, text: element.textContent, box, glyphs, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight});
    return {text: element.textContent, box, glyphs, metricAllowanceY, fontSize: style.fontSize, fontFamily: style.fontFamily, whiteSpace: style.whiteSpace, overflow};
  });
  const layouts = Array.from(scene.querySelectorAll('[data-layout-bound]'), (element, index) => {
    const box = rect(element);
    const overflow = outside(box, boundary);
    if (overflow) violations.push({type: 'OUTSIDE_CANVAS', index, className: element.className, box});
    return {className: element.className, box, overflow};
  });
  return {sceneId: scene.dataset.sceneId, template: scene.dataset.template, canvas: boundary, text, layouts, loadedFonts: Array.from(document.fonts).filter(font => font.status === 'loaded').map(font => ({family: font.family, weight: font.weight, style: font.style, unicodeRange: font.unicodeRange})), violations};
}

export async function observeBounds(browser, expected, state) {
  while (!state.finished) {
    for (const page of await browser.pages()) {
      try {
        const result = await page.evaluate(readBrowserBounds, expected);
        if (result) return {captured: true, ...result};
      } catch { /* The renderer creates and closes each still page. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  return {captured: false, reason: 'The still page closed before a matching frame could be observed.'};
}

export async function createMontage(outputDir, samples) {
  const width = 480, height = 270, gap = 12, columns = 3;
  const rows = Math.ceil(samples.length / columns);
  const layers = [];
  for (const [index, sample] of samples.entries()) {
    layers.push({input: await sharp(sample.image).resize(width, height).png().toBuffer(), left: gap + index % columns * (width + gap), top: gap + Math.floor(index / columns) * (height + gap)});
  }
  const montage = path.join(outputDir, 'montage.png');
  const buffer = await sharp({create: {width: gap + columns * (width + gap), height: gap + rows * (height + gap), channels: 3, background: '#0b1423'}}).composite(layers).png().toBuffer();
  await fs.writeFile(montage, buffer, {flag: 'wx'});
  return montage;
}

export async function inspectVisuals(options) {
  const browserExecutable = options.browserExecutable || defaultBrowser;
  if (!browserExecutable || !path.isAbsolute(browserExecutable) || !await exists(browserExecutable)) throw new Error('BROWSER_REQUIRED');
  // Read/verify all sources before creating evidence. No bundling or synthesis.
  const runs = [];
  for (const directory of options.runDirectories) runs.push(await sourceRun(directory));
  const outputDir = await createOutput(options.outputDir);
  const samples = [];
  let browser;
  try {
    browser = await openBrowser('chrome', {browserExecutable, chromiumOptions: {headless: true}, logLevel: 'error'});
    for (const run of runs) {
      const {storyboard, timeline} = run.inputProps;
      const composition = await selectComposition({serveUrl: run.bundleDirectory, id: 'ExplainerVideo', inputProps: run.inputProps, browserExecutable, puppeteerInstance: browser, logLevel: 'error'});
      if (composition.width !== 1280 || composition.height !== 720 || composition.fps !== 30 || composition.durationInFrames !== timeline.durationInFrames) throw new Error('COMPOSITION_METADATA_MISMATCH');
      for (const sample of sceneSamples(storyboard, timeline)) {
        const image = path.join(outputDir, `frame-${String(samples.length).padStart(3, '0')}.png`);
        const state = {finished: false};
        const rendering = renderStill({serveUrl: run.bundleDirectory, composition, inputProps: run.inputProps, frame: sample.frame, output: image, imageFormat: 'png', overwrite: false, browserExecutable, puppeteerInstance: browser, scale: 1, logLevel: 'error', onBrowserDownload: () => { throw new Error('BROWSER_DOWNLOAD_DISABLED'); }}).finally(() => { state.finished = true; });
        const expected = {sceneId: sample.sceneId, progress: timeline.scenes.map(timing => Math.min(1, Math.max(0, (sample.frame - timing.startFrame + 1) / timing.durationInFrames)))};
        const [, bounds] = await Promise.all([rendering, options.domBounds ? observeBounds(browser, expected, state) : Promise.resolve({captured: false, reason: 'DOM bounds were not requested.'})]);
        samples.push({...sample, targetSeconds: storyboard.targetDurationSec, sourceRun: run.directory, image, sha256: await sha256File(image), bounds});
        process.stdout.write(JSON.stringify({event: 'VISUAL_FRAME_CAPTURED', targetSeconds: storyboard.targetDurationSec, sceneId: sample.sceneId, frame: sample.frame, image, boundsCaptured: bounds.captured, overflowCount: bounds.violations?.length ?? null}) + '\n');
      }
    }
  } finally { if (browser) await browser.close({silent: true}); }
  const montage = await createMontage(outputDir, samples);
  const captured = samples.filter(sample => sample.bounds.captured);
  const violations = captured.flatMap(sample => sample.bounds.violations.map(violation => ({sceneId: sample.sceneId, frame: sample.frame, ...violation})));
  const boundsPassed = options.domBounds ? captured.length === samples.length && violations.length === 0 : null;
  const report = {reportVersion: 1, executionMode: 'LOCAL_VISUAL_QA', createdAt: new Date().toISOString(), outputDir, montage, sourceRuns: runs.map(run => ({directory: run.directory, generationId: run.preparation.generationId, storyboardHash: run.preparation.storyboardHash, bundleSha256: run.bundleSha256})), templates: [...new Set(samples.map(sample => sample.template))], stackQueueLayouts: [...new Set(samples.filter(sample => sample.layout).map(sample => sample.layout))], samples, domBounds: {requested: Boolean(options.domBounds), captured: captured.length, total: samples.length, violations, passed: boundsPassed}, limitations: ['PNG images require human visual inspection; geometric bounds do not prove diagram semantics or readability.', 'Bounds are read from exact frame progress using the browser object returned by the pinned renderer; unavailable observations never count as passes.', 'Computed font family does not prove glyph coverage for arbitrary Unicode or operating-system fallback fonts.', 'Only supplied completed-run fixtures are inspected; this command does not synthesize stress-case storyboards.']};
  const reportPath = path.join(outputDir, 'visual-qa.json');
  await writeJson(reportPath, report);
  process.stdout.write(JSON.stringify({event: 'VISUAL_QA_COMPLETED', reportPath, montage, frames: samples.length, boundsPassed}) + '\n');
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const options = parseVisualArguments(process.argv.slice(2));
    if (options.help) return process.stdout.write(usage + '\n');
    return inspectVisuals(options);
  }).catch(error => {
    const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'VISUAL_QA_FAILED';
    process.stderr.write(JSON.stringify({code, message: code === 'INVALID_ARGUMENTS' ? usage : 'Visual QA stopped; preserve source runs and partial inspection evidence.'}) + '\n');
    process.exitCode = 1;
  });
}
