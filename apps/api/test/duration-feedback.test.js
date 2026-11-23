import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {hashApprovedStoryboard} from '../../../packages/video-engine/src/contracts.js';
import {writeNarrationWav} from '../../../packages/video-engine/src/speech/audio.js';
import {narrationWords, safeDurationMeasurement, sanitizeDurationEvidence, trustedDurationFeedback, sameDurationRevisionVisuals} from '../src/projects/duration-feedback.js';
import {readDurationEvidence} from '../src/projects/duration-evidence.js';
import {planningPrompt} from '../src/projects/planner.js';

const fixture = JSON.parse(await fs.readFile(new URL('../../../packages/video-engine/fixtures/event-loop-30.json', import.meta.url), 'utf8'));
const evidence = () => ({measurementVersion: 1, sourceStoryboardHash: hashApprovedStoryboard(fixture), targetDurationSec: 30, measuredDurationSec: 41.6, narrationWords: narrationWords(fixture), sceneCount: 4, sceneAudioDurationMs: [10000, 10000, 10000, 10000], voice: 'af_heart', speed: 1, language: 'en'});
const job = value => ({status: 'FAILED', error: {code: 'DURATION_REVISION_REQUIRED'}, snapshot: fixture, storyboardId: fixture.id, approvedRevision: fixture.revision, storyboardHash: hashApprovedStoryboard(fixture), manifest: {durationFeedback: value}});

test('duration measurements allow only bounded failed target timing and never arbitrary diagnostics', () => {
  assert.deepEqual(safeDurationMeasurement({targetDurationSec: 30, measuredDurationSec: 41.6, privatePath: 'ignored'}), {targetDurationSec: 30, measuredDurationSec: 41.6});
  for (const value of [null, {}, {targetDurationSec: 45, measuredDurationSec: 60}, {targetDurationSec: 30, measuredDurationSec: Infinity}, {targetDurationSec: 30, measuredDurationSec: -1}, {targetDurationSec: 30, measuredDurationSec: 3601}, {targetDurationSec: 30, measuredDurationSec: 35}]) assert.equal(safeDurationMeasurement(value), null);
  assert.equal(safeDurationMeasurement({targetDurationSec: 30, measuredDurationSec: 42}, 60), null);
});

test('trusted feedback binds exact source, measured frame math and fixed narration profile', () => {
  const value = evidence(), feedback = trustedDurationFeedback(job(value));
  assert.equal(feedback.direction, 'SHORTEN'); assert.equal(feedback.narrationWords, 66); assert.equal(feedback.suggestedNarrationWords, 47);
  for (const change of [copy => {copy.sourceStoryboardHash = 'a'.repeat(64);}, copy => {copy.narrationWords++;}, copy => {copy.sceneAudioDurationMs[0]++;}, copy => {copy.voice = 'unverified';}, copy => {copy.speed = 1.1;}, copy => {copy.measuredDurationSec = 42;}]) {
    const invalid = structuredClone(value); change(invalid); assert.equal(trustedDurationFeedback(job(invalid)), null);
  }
  assert.equal(trustedDurationFeedback({...job(value), status: 'COMPLETED'}), null);
  const sanitized = sanitizeDurationEvidence({...value, privatePath: 'not-public', providerError: 'not-public'}, fixture);
  assert.equal(JSON.stringify(sanitized).includes('not-public'), false);
  assert.equal(sameDurationRevisionVisuals(fixture, {scenes: fixture.scenes.map(scene => ({...scene, narration: 'Changed narration.'}))}), true);
  assert.equal(sameDurationRevisionVisuals(fixture, {scenes: fixture.scenes.map(scene => ({...scene, visualProps: undefined}))}), false);
});

test('duration revision prompt preserves source visuals and uses measured guidance instead of a timing promise', () => {
  const feedback = trustedDurationFeedback(job(evidence()));
  const prompt = planningPrompt({prompt: 'Explain the event loop.', settings: fixture.settingsSnapshot, durationRevision: {feedback, scenes: fixture.scenes}});
  const input = JSON.parse(prompt.contents[0].parts[0].text);
  assert.equal(input.durationRevision.suggestedNarrationWords, 47);
  assert.deepEqual(input.durationRevision.scenes, fixture.scenes);
  assert.match(prompt.systemInstruction.parts[0].text, /Rewrite ONLY narration/u);
  assert.match(prompt.systemInstruction.parts[0].text, /exactly 2-4 nodes/u);
});

test('private failed-run evidence remeasures actual WAV bytes and rejects mismatches or escaped files', async () => {
  // Synthetic PCM is explicitly an integrity fixture, never a generated video.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = path.join(root, 'var/phase8-tests', 'duration-evidence-' + randomUUID());
  await fs.mkdir(path.join(directory, 'public/narration'), {recursive: true});
  const voiceHash = 'b'.repeat(64), modelHash = 'c'.repeat(64);
  const metadata = {provider: {provider: 'KOKORO', execution: 'LOCAL_CPU', voice: 'af_heart', language: 'en', speed: 1, sampleRate: 24000, dtype: 'q8', offline: true, modelId: 'fixture-model', modelVersion: modelHash, voiceSha256: voiceHash}, scenes: [], networkRequestsBlocked: 0};
  try {
    for (const scene of fixture.scenes) {
      const file = path.join(directory, 'public/narration', scene.sceneId + '.wav');
      const samples = Float32Array.from({length: 24000 * 10}, (_, index) => 0.1 * Math.sin(index * 2 * Math.PI * 440 / 24000));
      const result = await writeNarrationWav(file, samples);
      metadata.scenes.push({sceneId: scene.sceneId, filePath: file, ...result, provider: 'KOKORO', voice: 'af_heart', language: 'en', speed: 1, sampleRate: 24000, networkRequestsBlocked: 0, segments: [{text: scene.narration, startMs: 0, endMs: 10000}]});
    }
    await fs.writeFile(path.join(directory, 'storyboard.json'), JSON.stringify(fixture));
    await fs.writeFile(path.join(directory, 'model-manifest.json'), JSON.stringify({modelId: 'fixture-model', files: [{path: 'onnx/model_quantized.onnx', sha256: modelHash}], voice: {sha256: voiceHash}}));
    await fs.writeFile(path.join(directory, 'speech-metadata.json'), JSON.stringify(metadata));
    const read = () => readDurationEvidence({outputDir: directory, storyboard: fixture, details: {targetDurationSec: 30, measuredDurationSec: 41.6}});
    assert.deepEqual(await read(), evidence());
    metadata.scenes[0].sha256 = '0'.repeat(64);
    await fs.writeFile(path.join(directory, 'speech-metadata.json'), JSON.stringify(metadata));
    assert.equal(await read(), null);
    metadata.scenes[0].filePath = path.join(directory, '../outside.wav');
    await fs.writeFile(path.join(directory, 'speech-metadata.json'), JSON.stringify(metadata));
    assert.equal(await read(), null);
  } finally {
    assert.ok(path.resolve(directory).startsWith(path.join(root, 'var/phase8-tests') + path.sep));
    await fs.rm(directory, {recursive: true, force: true});
  }
});
