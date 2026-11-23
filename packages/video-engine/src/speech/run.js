import {readFile, writeFile, mkdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createKokoroSpeechProvider} from './kokoro.js';
import {speechError} from './audio.js';

/** Dedicated internal child: frees ONNX memory before the renderer starts. */
async function main() {
  const [requestFile] = process.argv.slice(2);
  if (!requestFile || !path.isAbsolute(requestFile)) throw speechError('TTS_INVALID_REQUEST', 'Pass one internally generated absolute request JSON path.');
  const request = JSON.parse(await readFile(requestFile, 'utf8'));
  if (!request || request.offline !== true || !path.isAbsolute(request.outputRoot || '') || !Array.isArray(request.scenes) || request.scenes.length < 2 || request.scenes.length > 18) {
    throw speechError('TTS_INVALID_REQUEST', 'The internal narration request must specify offline mode, outputRoot and 2–18 scenes.');
  }
  const ids = new Set();
  for (const scene of request.scenes) {
    if (!scene || typeof scene.sceneId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(scene.sceneId) || typeof scene.text !== 'string' || ids.has(scene.sceneId)) throw speechError('TTS_INVALID_REQUEST', 'Narration scene IDs must be safe and unique.');
    ids.add(scene.sceneId);
  }
  await mkdir(request.outputRoot, {recursive: true});
  const outputRoot = await realpath(request.outputRoot);
  const narrationRoot = path.join(outputRoot, 'narration');
  await mkdir(narrationRoot, {recursive: true});
  const resolvedNarrationRoot = await realpath(narrationRoot);
  const relativeNarration = path.relative(outputRoot, resolvedNarrationRoot);
  if (relativeNarration.startsWith('..') || path.isAbsolute(relativeNarration)) throw speechError('TTS_INVALID_OUTPUT', 'Narration workspace must stay inside the internally selected outputRoot.');

  const started = performance.now();
  const provider = await createKokoroSpeechProvider({modelPath: request.modelPath, cacheDir: request.cacheDir, voice: request.voice, offline: true});
  try {
    const scenes = [];
    for (const scene of request.scenes) {
      const result = await provider.synthesize({text: scene.text, outputPath: path.join(resolvedNarrationRoot, scene.sceneId + '.wav')});
      scenes.push({sceneId: scene.sceneId, ...result});
      process.stdout.write(JSON.stringify({event: 'NARRATION_SCENE_COMPLETED', sceneId: scene.sceneId, durationMs: result.durationMs, synthesisSeconds: result.synthesisSeconds}) + '\n');
    }
    const metadata = {provider: provider.metadata, scenes, elapsedSeconds: (performance.now() - started) / 1000, networkRequestsBlocked: provider.networkRequestsBlocked};
    await writeFile(path.join(outputRoot, 'speech-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx'});
    process.stdout.write(JSON.stringify({event: 'NARRATION_COMPLETED', sceneCount: scenes.length, elapsedSeconds: metadata.elapsedSeconds, networkRequestsBlocked: metadata.networkRequestsBlocked}) + '\n');
  } finally { await provider.dispose(); }
}

main().catch(error => {
  // Catch at the process boundary: never let Emscripten print an enormous source
  // dump for an uncaught application error or accidentally expose internal paths.
  process.stderr.write(JSON.stringify({code: error.code || 'TTS_CHILD_FAILED', message: error.message, ...(error.cause?.message ? {detail: String(error.cause.message).split('\n')[0].slice(0, 400)} : {})}) + '\n');
  process.exitCode = 1;
});
