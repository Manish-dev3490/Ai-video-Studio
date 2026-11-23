import fs from 'node:fs/promises';
import path from 'node:path';
import {hashApprovedStoryboard, normalizeTranscript, validateStoryboard} from '../../../../packages/video-engine/src/contracts.js';
import {measureNarration, inspectPcmWave} from '../../../../packages/video-engine/src/media.js';
import {safeDurationMeasurement, narrationWords} from './duration-feedback.js';

/** Re-measure only fixed files inside the owned renderer directory. No paths leave it. */
export async function readDurationEvidence({outputDir, storyboard, details}) {
  const measurement = safeDurationMeasurement(details, storyboard?.targetDurationSec);
  if (!measurement) return null;
  try {
    validateStoryboard(storyboard);
    const base = await fs.realpath(outputDir);
    async function owned(relative, maximum) {
      const file = path.join(base, relative), stat = await fs.lstat(file);
      const real = await fs.realpath(file), inside = path.relative(base, real);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximum || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('INVALID_DURATION_EVIDENCE');
      return {file: real, bytes: await fs.readFile(real)};
    }
    const saved = JSON.parse((await owned('storyboard.json', 262144)).bytes);
    const sourceStoryboardHash = hashApprovedStoryboard(storyboard);
    if (hashApprovedStoryboard(saved) !== sourceStoryboardHash) return null;
    const metadata = JSON.parse((await owned('speech-metadata.json', 1048576)).bytes);
    const model = JSON.parse((await owned('model-manifest.json', 262144)).bytes);
    const provider = metadata.provider;
    if (provider?.provider !== 'KOKORO' || provider.execution !== 'LOCAL_CPU' || provider.voice !== 'af_heart' || provider.language !== 'en' || provider.speed !== 1 || provider.sampleRate !== 24000 || provider.dtype !== 'q8' || provider.offline !== true || metadata.networkRequestsBlocked !== 0 || provider.modelId !== model.modelId || provider.modelVersion !== model.files?.find(item => item.path === 'onnx/model_quantized.onnx')?.sha256 || provider.voiceSha256 !== model.voice?.sha256) return null;
    if (!Array.isArray(metadata.scenes) || metadata.scenes.length !== storyboard.scenes.length) return null;
    const sceneAudioDurationMs = [];
    for (const [index, scene] of storyboard.scenes.entries()) {
      const entry = metadata.scenes[index];
      if (entry?.sceneId !== scene.sceneId || entry.provider !== 'KOKORO' || entry.voice !== 'af_heart' || entry.speed !== 1 || entry.language !== 'en' || entry.sampleRate !== 24000 || entry.networkRequestsBlocked !== 0 || !Number.isSafeInteger(entry.sampleCount) || entry.sampleCount <= 0 || entry.sampleCount > 24000 * 120 || !Array.isArray(entry.segments) || normalizeTranscript(entry.segments.map(segment => segment.text).join(' ')) !== normalizeTranscript(scene.narration)) return null;
      const audio = await owned(path.join('public', 'narration', scene.sceneId + '.wav'), 6000000);
      if (typeof entry.filePath !== 'string' || path.resolve(entry.filePath) !== path.resolve(audio.file)) return null;
      const measured = await measureNarration(audio.file), stats = inspectPcmWave(audio.bytes);
      if (measured.sha256 !== entry.sha256 || measured.bytes !== entry.sizeBytes || measured.durationMs !== entry.durationMs || measured.durationMs !== Math.ceil(entry.sampleCount * 1000 / 24000) || stats.sampleCount !== entry.sampleCount || !Number.isFinite(stats.rmsDbfs) || stats.rmsDbfs < -60 || stats.saturatedSamples !== 0) return null;
      sceneAudioDurationMs.push(measured.durationMs);
    }
    const measuredDurationSec = sceneAudioDurationMs.reduce((sum, time) => sum + 12 + Math.ceil(time * 30 / 1000), 0) / 30;
    if (Math.abs(measuredDurationSec - measurement.measuredDurationSec) > 0.000001) return null;
    return {measurementVersion: 1, sourceStoryboardHash, targetDurationSec: storyboard.targetDurationSec, measuredDurationSec, narrationWords: narrationWords(storyboard), sceneCount: storyboard.scenes.length, sceneAudioDurationMs, voice: 'af_heart', speed: 1, language: 'en'};
  } catch {return null;}
}
