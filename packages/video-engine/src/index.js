import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {bundle} from '@remotion/bundler';
import {openBrowser, renderMedia, selectComposition} from '@remotion/renderer';
import {DEFAULT_MODEL_PATH, ENGINE_ROOT, verifyKokoroSetup} from '../scripts/setup-kokoro.js';
import {EngineContractError, canonicalHash, hashApprovedStoryboard, validateStoryboard, validateTimeline} from './contracts.js';
import {buildTimeline} from './timeline.js';
import {serializeWebVtt, validateWebVtt} from './captions.js';
import {audioStats, measureNarration, nativeBinaries, readJson, sha256File, toolVersions, validateExport, writeJson} from './media.js';

export {DEFAULT_MODEL_PATH};
export {validateStoryboard, validateTimeline, hashApprovedStoryboard} from './contracts.js';
export {buildTimeline} from './timeline.js';
export {serializeWebVtt} from './captions.js';
export const DEFAULT_BROWSER_EXECUTABLE = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined;

const encoding = Object.freeze({videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p', colorSpace: 'bt709', width: 1280, height: 720, fps: 30, sampleRate: 48000, imageFormat: 'jpeg', jpegQuality: 90, crf: 20, x264Preset: 'medium', concurrency: 1});
const captionConfiguration = Object.freeze({format: 'WEBVTT', mimeType: 'text/vtt', exportBurnIn: false, timing: 'MEASURED_PCM_CHUNKS_CEIL_TO_FRAME'});
const secondsSince = started => (performance.now() - started) / 1000;
const emit = (callback, event) => { if (callback) callback(event); };
const fail = (code, message, details) => { throw new EngineContractError(code, message, details); };
const samePath = (first, second) => path.resolve(first) === path.resolve(second);
const protectedDirectories = ['docs', 'review', 'video-engine-poc', '.git'];
const containsPath = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

function outputPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('INVALID_OUTPUT_DIRECTORY', 'Select an absolute output directory.');
  const directory = path.resolve(input);
  const repository = path.resolve(ENGINE_ROOT, '../..');
  for (const name of protectedDirectories) {
    if (containsPath(path.join(repository, name), directory)) fail('PROTECTED_OUTPUT_DIRECTORY', 'Output must stay outside approved documentation and the preserved prototype.');
  }
  return directory;
}

/** Resolve all existing junctions before even creating missing parent folders. */
async function resolvedOutputPath(input) {
  const requested = outputPath(input);
  const missing = [];
  let cursor = requested;
  let existing;
  while (!existing) {
    try { existing = await fsp.realpath(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling link is an existing filesystem object, not a missing folder.
      try {
        await fsp.lstat(cursor);
        fail('INVALID_OUTPUT_DIRECTORY', 'Output cannot pass through a dangling directory link.');
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = path.dirname(cursor);
      if (parent === cursor) fail('INVALID_OUTPUT_DIRECTORY', 'Output has no accessible existing parent directory.');
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  const resolved = outputPath(path.join(existing, ...missing));
  const repository = path.resolve(ENGINE_ROOT, '../..');
  for (const name of protectedDirectories) {
    const protectedPath = path.join(repository, name);
    let protectedRealPath;
    try { protectedRealPath = await fsp.realpath(protectedPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
    if (containsPath(protectedRealPath, resolved)) fail('PROTECTED_OUTPUT_DIRECTORY', 'Output must stay outside approved documentation and the preserved prototype.');
  }
  // Use the resolved path for subsequent writes, rather than traversing a checked
  // junction a second time through its original alias.
  return resolved;
}

async function assertRegularFile(file, base) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ARTIFACT_INTEGRITY_FAILED', 'Expected a regular, internally resolved artifact.');
  const resolved = await fsp.realpath(file);
  const root = await fsp.realpath(base);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) fail('ARTIFACT_INTEGRITY_FAILED', 'An artifact escaped the private output workspace.');
  return stat;
}

function runSpeech(requestFile, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ENGINE_ROOT, 'src/speech/run.js'), requestFile], {cwd: ENGINE_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let pending = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending = (pending + chunk).slice(-65536);
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop();
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.event === 'NARRATION_SCENE_COMPLETED') emit(onProgress, {stage: 'SYNTHESIZE_AUDIO', ...value});
        } catch { /* Non-JSON runtime diagnostics are not public progress. */ }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
    child.once('error', () => reject(new EngineContractError('TTS_CHILD_FAILED', 'The isolated local narration process could not start.')));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) return resolve();
      let childCode;
      for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
        try { childCode = JSON.parse(line).code; if (childCode) break; } catch { /* Keep diagnostics private. */ }
      }
      reject(new EngineContractError(typeof childCode === 'string' && /^[A-Z0-9_]{1,80}$/u.test(childCode) ? childCode : 'TTS_CHILD_FAILED', 'Local narration failed; no video was published.', {exitCode: code, signal}));
    });
  });
}

async function measureSceneAudio({storyboard, speech, directory, modelManifest}) {
  const provider = speech?.provider;
  const model = modelManifest.files.find(file => file.path === 'onnx/model_quantized.onnx');
  if (!provider || provider.provider !== 'KOKORO' || provider.execution !== 'LOCAL_CPU' || provider.offline !== true || provider.voice !== 'af_heart' || provider.language !== 'en' || provider.speed !== 1 || provider.dtype !== 'q8' || provider.sampleRate !== 24000 || provider.modelId !== modelManifest.modelId || provider.modelVersion !== model.sha256 || provider.voiceSha256 !== modelManifest.voice.sha256 || speech.networkRequestsBlocked !== 0) fail('TTS_PROVENANCE_MISMATCH', 'Narration does not match the verified local model, voice and fixed speed.');
  if (!Array.isArray(speech.scenes) || speech.scenes.length !== storyboard.scenes.length) fail('INVALID_AUDIO_METADATA', 'Exactly one narration artifact is required per scene.');
  const audio = [];
  for (const [index, scene] of storyboard.scenes.entries()) {
    const record = speech.scenes[index];
    const expected = path.join(directory, 'public/narration', scene.sceneId + '.wav');
    if (!record || record.sceneId !== scene.sceneId || typeof record.filePath !== 'string' || !samePath(record.filePath, expected) || record.provider !== 'KOKORO' || record.voice !== 'af_heart' || record.speed !== 1 || record.language !== 'en' || record.sampleRate !== 24000 || !Number.isSafeInteger(record.sampleCount) || record.sampleCount < 1 || record.networkRequestsBlocked !== 0) fail('INVALID_AUDIO_METADATA', 'Narration metadata must resolve to the expected internal scene WAV.');
    const fileStat = await assertRegularFile(expected, directory);
    const measured = await measureNarration(expected);
    const stats = await audioStats(expected);
    if (measured.sha256 !== record.sha256 || measured.bytes !== record.sizeBytes || fileStat.size !== record.sizeBytes || stats.sampleCount !== record.sampleCount || measured.durationMs !== Math.ceil(record.sampleCount * 1000 / 24000) || measured.durationMs !== record.durationMs || !Number.isFinite(stats.rmsDbfs) || stats.rmsDbfs < -60 || stats.saturatedSamples !== 0) fail('AUDIO_INTEGRITY_FAILED', 'The measured narration samples, duration or checksum differ from synthesis metadata.');
    audio.push({sceneId: scene.sceneId, filePath: expected, durationMs: measured.durationMs, segments: record.segments, audioAssetId: 'audio_' + scene.sceneId, sha256: measured.sha256, sampleCount: record.sampleCount, sampleRate: measured.sampleRate, bytes: measured.bytes, normalization: record.normalization, synthesisSeconds: record.synthesisSeconds, stats});
  }
  return audio;
}

/** Offline preparation never edits the approved storyboard or reuses an old run. */
export async function prepareVideo({storyboard, outputDir, modelPath = DEFAULT_MODEL_PATH, onProgress} = {}) {
  const started = performance.now();
  const frozen = structuredClone(storyboard);
  validateStoryboard(frozen);
  const storyboardHash = hashApprovedStoryboard(frozen);
  const directory = await resolvedOutputPath(outputDir);
  const resolvedModelPath = path.resolve(modelPath);
  const modelManifest = await verifyKokoroSetup(resolvedModelPath);
  nativeBinaries();
  await fsp.mkdir(path.dirname(directory), {recursive: true});
  try { await fsp.mkdir(directory); } catch (error) { if (error.code === 'EEXIST') fail('OUTPUT_DIRECTORY_EXISTS', 'Use a fresh output directory; previous runs are preserved.'); throw error; }
  const timings = {prepareAssetsSeconds: secondsSince(started)};
  emit(onProgress, {stage: 'PREPARE_ASSETS', event: 'STAGE_COMPLETED'});
  await fsp.mkdir(path.join(directory, 'public'));
  await writeJson(path.join(directory, 'storyboard.json'), frozen);
  await writeJson(path.join(directory, 'model-manifest.json'), modelManifest);
  const requestFile = path.join(directory, 'speech-request.json');
  const cacheDir = path.join(ENGINE_ROOT, '.cache/transformers');
  await writeJson(requestFile, {modelPath: resolvedModelPath, cacheDir, voice: 'af_heart', offline: true, outputRoot: path.join(directory, 'public'), scenes: frozen.scenes.map(scene => ({sceneId: scene.sceneId, text: scene.narration}))});
  const speechStarted = performance.now();
  emit(onProgress, {stage: 'SYNTHESIZE_AUDIO', event: 'STAGE_STARTED'});
  await runSpeech(requestFile, onProgress);
  timings.synthesizeAudioSeconds = secondsSince(speechStarted);
  const speechMetadataPath = 'speech-metadata.json';
  const childMetadataPath = path.join(directory, 'public/speech-metadata.json');
  await assertRegularFile(childMetadataPath, directory);
  // The child has exited and no render server exists yet. Retain its private
  // metadata outside public/ before any bundle can copy or serve that directory.
  await fsp.link(childMetadataPath, path.join(directory, speechMetadataPath));
  await fsp.unlink(childMetadataPath);
  const speech = await readJson(path.join(directory, speechMetadataPath));
  emit(onProgress, {stage: 'SYNTHESIZE_AUDIO', event: 'STAGE_COMPLETED'});
  const alignStarted = performance.now();
  const audio = await measureSceneAudio({storyboard: frozen, speech, directory, modelManifest});
  const timeline = buildTimeline({storyboard: frozen, audio});
  const audioSources = Object.fromEntries(frozen.scenes.map(scene => [scene.sceneId, 'narration/' + scene.sceneId + '.wav']));
  const inputProps = {storyboard: frozen, timeline, audioSources};
  await writeJson(path.join(directory, 'timeline.json'), timeline);
  await writeJson(path.join(directory, 'input-props.json'), inputProps);
  await fsp.writeFile(path.join(directory, 'captions.vtt'), serializeWebVtt({timeline, language: 'en'}), {flag: 'wx'});
  timings.alignTimelineSeconds = secondsSince(alignStarted);
  timings.preparationSeconds = secondsSince(started);
  const preparation = {preparationVersion: 1, executionMode: 'LOCAL_QA', generationId: 'local_' + randomUUID().replaceAll('-', ''), preparedAt: new Date().toISOString(), storyboardHash, storyboardFileSha256: await sha256File(path.join(directory, 'storyboard.json')), timelineSha256: canonicalHash(timeline), timelineFileSha256: await sha256File(path.join(directory, 'timeline.json')), inputPropsSha256: await sha256File(path.join(directory, 'input-props.json')), captionSha256: await sha256File(path.join(directory, 'captions.vtt')), speechMetadataPath, speechMetadataSha256: await sha256File(path.join(directory, speechMetadataPath)), modelManifestSha256: await sha256File(path.join(directory, 'model-manifest.json')), modelPath: resolvedModelPath, cacheDir, audio, speech: speech.provider, timings, retention: {mode: 'PRIVATE_QA_EVIDENCE', automaticExpiryEnforced: false}};
  await writeJson(path.join(directory, 'preparation.json'), preparation);
  emit(onProgress, {stage: 'ALIGN_TIMELINE', event: 'STAGE_COMPLETED', durationInFrames: timeline.durationInFrames});
  return {outputDir: directory, captionPath: path.join(directory, 'captions.vtt'), storyboardHash, timeline, audio, preparation, timings};
}

async function readVerifiedPreparation(directory) {
  const preparation = await readJson(path.join(directory, 'preparation.json'));
  if (preparation.preparationVersion !== 1 || preparation.executionMode !== 'LOCAL_QA') fail('INVALID_PREPARATION', 'Only a verified local preparation can be rendered.');
  const speechMetadataPath = preparation.speechMetadataPath ?? 'public/speech-metadata.json';
  if (!['speech-metadata.json', 'public/speech-metadata.json'].includes(speechMetadataPath)) fail('INVALID_PREPARATION', 'Speech metadata must use an internally selected private or legacy artifact name.');
  const checks = [['storyboard.json', preparation.storyboardFileSha256], ['timeline.json', preparation.timelineFileSha256], ['input-props.json', preparation.inputPropsSha256], ['captions.vtt', preparation.captionSha256], [speechMetadataPath, preparation.speechMetadataSha256], ['model-manifest.json', preparation.modelManifestSha256]];
  for (const [name, expected] of checks) {
    await assertRegularFile(path.join(directory, name), directory);
    if (!expected || await sha256File(path.join(directory, name)) !== expected) fail('PREPARATION_INTEGRITY_FAILED', 'A frozen preparation artifact changed; create a new approved run.');
  }
  const storyboard = await readJson(path.join(directory, 'storyboard.json'));
  const timeline = await readJson(path.join(directory, 'timeline.json'));
  const inputProps = await readJson(path.join(directory, 'input-props.json'));
  validateTimeline(storyboard, timeline);
  if (hashApprovedStoryboard(storyboard) !== preparation.storyboardHash || canonicalHash(timeline) !== preparation.timelineSha256 || canonicalHash(inputProps.storyboard) !== canonicalHash(storyboard) || canonicalHash(inputProps.timeline) !== canonicalHash(timeline)) fail('PREPARATION_INTEGRITY_FAILED', 'Approved content and render inputs no longer match.');
  const sources = Object.fromEntries(storyboard.scenes.map(scene => [scene.sceneId, 'narration/' + scene.sceneId + '.wav']));
  if (canonicalHash(sources) !== canonicalHash(inputProps.audioSources)) fail('PREPARATION_INTEGRITY_FAILED', 'Audio sources must be internally derived scene files.');
  validateWebVtt({timeline, text: await fsp.readFile(path.join(directory, 'captions.vtt'), 'utf8'), language: 'en'});
  const modelManifest = await readJson(path.join(directory, 'model-manifest.json'));
  const speech = await readJson(path.join(directory, speechMetadataPath));
  const audio = await measureSceneAudio({storyboard, speech, directory, modelManifest});
  if (canonicalHash(audio) !== canonicalHash(preparation.audio) || canonicalHash(speech.provider) !== canonicalHash(preparation.speech) || canonicalHash(buildTimeline({storyboard, audio})) !== canonicalHash(timeline)) fail('PREPARATION_INTEGRITY_FAILED', 'Measured audio and the prepared timeline no longer match.');
  return {preparation, storyboard, timeline, inputProps, audio};
}

async function directoryFingerprint(directory) {
  const records = [];
  const walk = async relative => {
    for (const entry of (await fsp.readdir(path.join(directory, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail('BUNDLE_INTEGRITY_FAILED', 'The retained render bundle must contain regular files.');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) records.push({file: name.split(path.sep).join('/'), sha256: await sha256File(path.join(directory, name))});
    }
  };
  await walk('');
  return {sha256: canonicalHash(records), files: records};
}

async function validateInternalManifest(definition, value) {
  const schemaRoot = new URL('../../../review/phase-1-contracts/schemas/', import.meta.url);
  const sceneUrl = new URL('scene.schema.json', schemaRoot);
  const jobUrl = new URL('job.schema.json', schemaRoot);
  const ajv = new Ajv2020({strict: false, allErrors: true});
  addFormats(ajv);
  ajv.addSchema(await readJson(fileURLToPath(sceneUrl)), sceneUrl.href);
  ajv.addSchema(await readJson(fileURLToPath(jobUrl)), jobUrl.href);
  const validate = ajv.getSchema(jobUrl.href + '#/$defs/' + definition);
  if (!validate(value)) fail('MANIFEST_VALIDATION_FAILED', 'Internal execution metadata does not match the canonical contract.', validate.errors);
}

/** Reuses only checksum-verified preparation; never accepts a model-generated path. */
export async function renderPrepared({outputDir, browserExecutable = DEFAULT_BROWSER_EXECUTABLE, concurrency = 1, onProgress} = {}) {
  const started = performance.now();
  const directory = await resolvedOutputPath(outputDir);
  if (concurrency !== 1) fail('UNSUPPORTED_CONCURRENCY', 'The validated CPU profile uses one render frame at a time.');
  if (!browserExecutable || !path.isAbsolute(browserExecutable) || !fs.existsSync(browserExecutable)) fail('BROWSER_REQUIRED', 'Select an already installed Chrome executable; browser downloads are disabled.');
  for (const name of ['video.mp4', 'result.json', 'validation.json', 'published-export-manifest.json']) if (fs.existsSync(path.join(directory, name))) fail('OUTPUT_ALREADY_PUBLISHED', 'This output directory already contains a final artifact; use a fresh run.');
  const lockPath = path.join(directory, 'render.lock');
  let lock;
  try { lock = await fsp.open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') fail('RENDER_ALREADY_RUNNING', 'This prepared run is already being rendered.'); throw error; }
  const renderId = randomUUID().replaceAll('-', '');
  let browser;
  try {
    const {preparation, storyboard, timeline, inputProps, audio} = await readVerifiedPreparation(directory);
    const timings = {...preparation.timings};
    const bundlingStarted = performance.now();
    const bundleDirectory = path.join(directory, fs.existsSync(path.join(directory, 'bundle')) ? 'bundle-' + renderId : 'bundle');
    const serveUrl = await bundle({entryPoint: path.join(ENGINE_ROOT, 'src/remotion/entry.jsx'), rootDir: ENGINE_ROOT, publicDir: path.join(directory, 'public'), outDir: bundleDirectory, rspack: true, enableCaching: false, gitSource: null, symlinkPublicDir: false, onProgress: progress => emit(onProgress, {stage: 'RENDER_VIDEO', event: 'BUNDLE_PROGRESS', progress})});
    timings.bundleSeconds = secondsSince(bundlingStarted);
    const fingerprint = await directoryFingerprint(bundleDirectory);
    await writeJson(path.join(directory, 'bundle-files-' + renderId + '.json'), fingerprint);
    browser = await openBrowser('chrome', {browserExecutable, chromiumOptions: {headless: true}, logLevel: 'error'});
    const browserInfo = (await browser.connection.send('Browser.getVersion')).value;
    const composition = await selectComposition({serveUrl, id: 'ExplainerVideo', inputProps, browserExecutable, puppeteerInstance: browser, logLevel: 'error'});
    if (composition.durationInFrames !== timeline.durationInFrames || composition.fps !== 30 || composition.width !== 1280 || composition.height !== 720) fail('COMPOSITION_METADATA_MISMATCH', 'The renderer composition does not match the measured output profile.');
    const versions = await toolVersions();
    const packageJson = await readJson(path.join(ENGINE_ROOT, 'package.json'));
    const installedDependencies = Object.fromEntries(await Promise.all(Object.entries(packageJson.dependencies).map(async ([name, expected]) => {
      const installed = await readJson(path.join(ENGINE_ROOT, 'node_modules', name, 'package.json'));
      if (installed.version !== expected) fail('DEPENDENCY_VERSION_MISMATCH', 'Installed engine dependencies differ from the pinned execution profile.');
      return [name, installed.version];
    })));
    const fonts = [];
    for (const weight of [400, 600, 700]) {
      const file = path.join(ENGINE_ROOT, 'node_modules/@fontsource/inter/files/inter-latin-' + weight + '-normal.woff2');
      fonts.push({family: 'Inter Latin ' + weight, sha256: await sha256File(file)});
    }
    const speechConfigurationSha256 = canonicalHash(preparation.speech);
    const configurationSnapshotId = 'speech_' + speechConfigurationSha256.slice(0, 32);
    const speechConfigurationFile = path.join(directory, configurationSnapshotId + '.json');
    try { await writeJson(speechConfigurationFile, preparation.speech); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await assertRegularFile(speechConfigurationFile, directory);
      if (canonicalHash(await readJson(speechConfigurationFile)) !== speechConfigurationSha256) fail('PREPARATION_INTEGRITY_FAILED', 'The retained speech configuration snapshot changed.');
    }
    const captionArtifact = {assetId: 'captions_' + preparation.generationId, sha256: preparation.captionSha256, mimeType: 'text/vtt', language: 'en', timelineSha256: preparation.timelineSha256};
    const manifest = {manifestVersion: 1, generationId: preparation.generationId, attempt: 1, approvedInput: {storyboardId: storyboard.id, approvedRevision: storyboard.revision, storyboardHash: preparation.storyboardHash}, provenance: {engineVersion: packageJson.version, bundleSha256: fingerprint.sha256, templateRegistryVersion: 'phase2-five-templates-v1', remotionVersion: packageJson.dependencies.remotion, browserVersion: browserInfo.product, ...{ffmpegVersion: versions.ffmpeg, ffprobeVersion: versions.ffprobe}, speech: {provider: preparation.speech.provider, modelVersion: preparation.speech.modelVersion, voiceId: preparation.speech.voice, configurationSha256: speechConfigurationSha256, configurationSnapshotId}, fonts, encoding: {videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p', width: 1280, height: 720, fps: 30, configurationSha256: canonicalHash(encoding)}, captions: {mimeType: 'text/vtt', exportBurnIn: false, configurationSha256: canonicalHash(captionConfiguration)}}, timeline, narrationAssets: audio.map(entry => ({sceneId: entry.sceneId, assetId: entry.audioAssetId, sha256: entry.sha256, durationMs: entry.durationMs})), createdAt: new Date().toISOString(), captionArtifact};
    await validateInternalManifest('RenderManifest', manifest);
    const manifestName = 'render-manifest-' + renderId + '.json';
    await writeJson(path.join(directory, manifestName), manifest);
    await writeJson(path.join(directory, 'render-configuration-' + renderId + '.json'), {encoding, captions: captionConfiguration, browserExecutable, browser: browserInfo, browserSha256: await sha256File(browserExecutable), nodeVersion: process.version, platform: process.platform, arch: process.arch, engineDependencies: installedDependencies, dependencyLockSha256: await sha256File(path.join(ENGINE_ROOT, 'package-lock.json')), fontPackageVersion: installedDependencies['@fontsource/inter'], retention: preparation.retention});
    const partial = path.join(directory, 'video-' + renderId + '.partial.mp4');
    const renderStarted = performance.now();
    emit(onProgress, {stage: 'RENDER_VIDEO', event: 'STAGE_STARTED', durationInFrames: timeline.durationInFrames});
    let reportedFrames = -30;
    await renderMedia({serveUrl, composition, inputProps, puppeteerInstance: browser, browserExecutable, outputLocation: partial, codec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p', colorSpace: 'bt709', sampleRate: 48000, imageFormat: 'jpeg', jpegQuality: 90, crf: 20, x264Preset: 'medium', concurrency, overwrite: false, enforceAudioTrack: true, muted: false, logLevel: 'error', binariesDirectory: nativeBinaries().directory, onBrowserDownload: () => fail('BROWSER_DOWNLOAD_DISABLED', 'Use the selected installed Chrome executable.'), onProgress: ({renderedFrames, encodedFrames}) => { if (renderedFrames - reportedFrames >= 30 || renderedFrames === timeline.durationInFrames) { reportedFrames = renderedFrames; emit(onProgress, {stage: 'RENDER_VIDEO', event: 'RENDER_PROGRESS', renderedFrames, encodedFrames, totalFrames: timeline.durationInFrames}); } }});
    timings.renderVideoSeconds = secondsSince(renderStarted);
    await browser.close({silent: true});
    browser = undefined;
    emit(onProgress, {stage: 'RENDER_VIDEO', event: 'STAGE_COMPLETED'});
    const validateStarted = performance.now();
    const captionPath = path.join(directory, 'captions.vtt');
    const validation = await validateExport({storyboard, timeline, videoPath: partial, captionPath, audio});
    timings.validateOutputSeconds = secondsSince(validateStarted);
    emit(onProgress, {stage: 'VALIDATE_OUTPUT', event: 'STAGE_COMPLETED'});
    // Hard-link creation is atomic and refuses to replace any existing final MP4.
    // It also avoids POSIX rename's silent overwrite behavior.
    const videoPath = path.join(directory, 'video.mp4');
    await fsp.link(partial, videoPath);
    await fsp.unlink(partial);
    const verifiedPublishedAt = new Date().toISOString();
    const published = {manifestVersion: 1, generationId: preparation.generationId, attempt: 1, renderManifestSha256: canonicalHash(manifest), videoArtifact: {assetId: 'video_' + preparation.generationId, sha256: await sha256File(videoPath), mimeType: 'video/mp4'}, captionArtifact, verifiedPublishedAt, expiresAt: new Date(Date.parse(verifiedPublishedAt) + 604800000).toISOString()};
    await validateInternalManifest('PublishedExportManifest', published);
    await writeJson(path.join(directory, 'published-export-manifest.json'), published);
    await writeJson(path.join(directory, 'validation.json'), validation);
    timings.renderPreparedSeconds = secondsSince(started);
    timings.totalSeconds = timings.preparationSeconds + timings.renderPreparedSeconds;
    const result = {status: 'COMPLETED', executionMode: 'LOCAL_QA', outputDir: directory, videoPath, captionPath, generationId: preparation.generationId, storyboardHash: preparation.storyboardHash, renderManifestPath: path.join(directory, manifestName), publishedManifestPath: path.join(directory, 'published-export-manifest.json'), timeline, validation, timings, retention: {mode: 'PRIVATE_QA_EVIDENCE', automaticExpiryEnforced: false, contractExpiryMetadataOnly: true}, serviceFeaturesImplemented: {assetOwnership: false, queue: false, quota: false, cancellation: false, retentionService: false}};
    await writeJson(path.join(directory, 'result.json'), result);
    emit(onProgress, {stage: 'LOCAL_PUBLICATION', event: 'STAGE_COMPLETED', status: 'COMPLETED'});
    return result;
  } finally {
    if (browser) await browser.close({silent: true}).catch(() => {});
    await lock.close();
    await fsp.unlink(lockPath);
  }
}

export async function renderExplainer(options) {
  const prepared = await prepareVideo(options);
  return renderPrepared({...options, outputDir: prepared.outputDir});
}
