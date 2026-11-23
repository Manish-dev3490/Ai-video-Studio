import {createHash} from 'node:crypto';
import {createReadStream, readFileSync} from 'node:fs';
import {access, mkdir, readFile, realpath, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {KOKORO_SAMPLE_RATE, inspectPcm, normalizePcm, speechError, writeNarrationWav} from './audio.js';
import {assertContextFits, normalizeNarrationWhitespace, splitNarration} from './text.js';

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_MODEL_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_VOICE = 'af_heart';
export const KOKORO_MODEL_FILES = Object.freeze(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']);

const require = createRequire(import.meta.url);
let providerActive = false;

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

async function assertOutputAbsent(outputPath) {
  if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.wav') {
    throw speechError('TTS_INVALID_OUTPUT', 'Narration output must be an internally resolved absolute WAV path.');
  }
  try {
    await access(outputPath);
    throw speechError('TTS_OUTPUT_EXISTS', 'Narration output already exists; overwriting is disabled.');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
}

/**
 * One offline CPU provider per dedicated speech process. Model acquisition is
 * deliberately separate; this factory never downloads a model or calls cloud TTS.
 */
export async function createKokoroSpeechProvider({modelPath, cacheDir, voice = KOKORO_VOICE, dtype = 'q8', offline = true} = {}) {
  if (offline !== true) throw speechError('TTS_OFFLINE_REQUIRED', 'This provider requires offline generation; acquire model assets separately.');
  if (voice !== KOKORO_VOICE || dtype !== 'q8') throw speechError('TTS_UNSUPPORTED_PROFILE', 'The initial tested profile is af_heart English, q8, local CPU at natural speed.');
  if (!modelPath || !cacheDir || !path.isAbsolute(modelPath) || !path.isAbsolute(cacheDir)) {
    throw speechError('TTS_INVALID_MODEL_PATH', 'Explicit absolute local model and cache directories are required.');
  }
  if (providerActive) throw speechError('TTS_PROVIDER_IN_USE', 'Use one Kokoro provider per dedicated speech process.');
  const resolvedModel = await realpath(modelPath).catch(cause => { throw speechError('TTS_MODEL_MISSING', 'Local Kokoro model is missing. Run the separate model setup command.', cause); });
  const modelFiles = [];
  for (const relative of KOKORO_MODEL_FILES) {
    const file = path.join(resolvedModel, relative);
    const info = await stat(file).catch(cause => { throw speechError('TTS_MODEL_MISSING', 'A required local Kokoro model asset is missing.', cause); });
    if (!info.isFile() || info.size === 0) throw speechError('TTS_MODEL_INVALID', 'A local Kokoro model asset is empty or invalid.');
    modelFiles.push({file: relative, bytes: info.size, sha256: await sha256File(file)});
  }
  const config = JSON.parse(await readFile(path.join(resolvedModel, 'config.json'), 'utf8'));
  if (config.model_type !== 'style_text_to_speech_2') throw speechError('TTS_MODEL_INVALID', 'The local model is not a compatible Kokoro model.');
  await mkdir(cacheDir, {recursive: true});

  const kokoroRoot = path.resolve(path.dirname(require.resolve('kokoro-js')), '..');
  const transformersRoot = path.resolve(path.dirname(require.resolve('@huggingface/transformers')), '..');
  const kokoroRequire = createRequire(path.join(kokoroRoot, 'package.json'));
  const nestedTransformersRoot = path.resolve(path.dirname(kokoroRequire.resolve('@huggingface/transformers')), '..');
  if (await realpath(transformersRoot) !== await realpath(nestedTransformersRoot)) {
    throw speechError('TTS_DEPENDENCY_MISMATCH', 'Kokoro and the provider must use the same Transformers.js installation for offline controls.');
  }
  const voicePath = path.join(kokoroRoot, 'voices', voice + '.bin');
  const voiceInfo = await stat(voicePath).catch(cause => { throw speechError('TTS_VOICE_MISSING', 'The packaged local English voice is missing.', cause); });
  if (voiceInfo.size < 510 * 256 * 4) throw speechError('TTS_VOICE_INVALID', 'The local English voice data is incomplete.');
  const libraryVersion = JSON.parse(readFileSync(path.join(kokoroRoot, 'package.json'), 'utf8')).version;
  const transformersVersion = JSON.parse(readFileSync(path.join(transformersRoot, 'package.json'), 'utf8')).version;

  providerActive = true;
  const previousFetch = globalThis.fetch;
  let networkRequestsBlocked = 0;
  globalThis.fetch = function offlineFetch(resource, options) {
    const url = typeof resource === 'string' ? resource : resource?.url ?? String(resource);
    if (/^https?:/iu.test(url)) {
      networkRequestsBlocked++;
      return Promise.reject(speechError('TTS_NETWORK_DISABLED', 'Network access is disabled during local narration generation.'));
    }
    return previousFetch.call(globalThis, resource, options);
  };
  let hf;
  let previousEnvironment;
  let tts;
  let busy = false;
  let disposed = false;
  const loadStarted = performance.now();
  const restore = () => {
    if (hf && previousEnvironment) Object.assign(hf, previousEnvironment);
    globalThis.fetch = previousFetch;
    providerActive = false;
  };
  try {
    const kokoro = await import('kokoro-js');
    const transformers = await import('@huggingface/transformers');
    hf = transformers.env;
    previousEnvironment = {
      allowRemoteModels: hf.allowRemoteModels,
      allowLocalModels: hf.allowLocalModels,
      cacheDir: hf.cacheDir,
      useFSCache: hf.useFSCache,
      useBrowserCache: hf.useBrowserCache,
    };
    Object.assign(hf, {allowRemoteModels: false, allowLocalModels: true, cacheDir, useFSCache: false, useBrowserCache: false});
    tts = await kokoro.KokoroTTS.from_pretrained(resolvedModel, {device: 'cpu', dtype: 'q8'});
    const metadata = {
      provider: 'KOKORO', execution: 'LOCAL_CPU', modelId: KOKORO_MODEL_ID,
      modelVersion: modelFiles.find(file => file.file.endsWith('.onnx')).sha256,
      dtype, voice, voiceSha256: await sha256File(voicePath), language: 'en', speed: 1,
      sampleRate: KOKORO_SAMPLE_RATE, library: 'kokoro-js', libraryVersion, transformersVersion,
      offline: true, modelFiles, loadSeconds: (performance.now() - loadStarted) / 1000,
      normalization: {method: 'LINEAR_RMS_WITH_PEAK_CEILING', targetRmsDb: -20, peakCeilingDb: -1, maxGainDb: 12},
    };

    return {
      metadata,
      async synthesize({text, outputPath}) {
        if (disposed) throw speechError('TTS_PROVIDER_DISPOSED', 'The Kokoro provider has already been disposed.');
        if (busy) throw speechError('TTS_PROVIDER_BUSY', 'Concurrent narration generation is disabled for the initial local profile.');
        const chunks = splitNarration(text);
        await assertOutputAbsent(outputPath);
        busy = true;
        const started = performance.now();
        try {
          const audioParts = [];
          const segments = [];
          let sampleCount = 0;
          for (const chunk of chunks) {
            // Explicitly close: upstream stream(string) does not close its splitter.
            const splitter = new kokoro.TextSplitterStream();
            splitter.push(chunk);
            splitter.close();
            for await (const generated of tts.stream(splitter, {voice, speed: 1})) {
              const tokenized = tts.tokenizer(generated.phonemes, {truncation: false});
              const ids = tokenized.input_ids;
              const tokenCount = ids?.dims?.at(-1) ?? (Array.isArray(ids?.[0]) ? ids[0].length : ids?.length);
              assertContextFits(tokenCount);
              const pcm = generated.audio.audio;
              if (generated.audio.sampling_rate !== KOKORO_SAMPLE_RATE) throw speechError('TTS_INVALID_AUDIO', 'Kokoro returned an unexpected sample rate.');
              inspectPcm(pcm, KOKORO_SAMPLE_RATE);
              const segmentText = normalizeNarrationWhitespace(generated.text);
              if (!segmentText || Array.from(segmentText).length > 300) throw speechError('TTS_TEXT_COVERAGE', 'A speech segment exceeds the caption text limit.');
              const startMs = Math.round(sampleCount * 1000 / KOKORO_SAMPLE_RATE);
              sampleCount += pcm.length;
              if (sampleCount > KOKORO_SAMPLE_RATE * 120) throw speechError('TTS_AUDIO_TOO_LONG', 'Scene speech exceeds the bounded local narration runtime; revise the script.');
              segments.push({text: segmentText, startMs, endMs: Math.round(sampleCount * 1000 / KOKORO_SAMPLE_RATE)});
              audioParts.push(pcm);
            }
          }
          if (!audioParts.length || normalizeNarrationWhitespace(segments.map(segment => segment.text).join(' ')) !== normalizeNarrationWhitespace(text)) {
            throw speechError('TTS_TEXT_COVERAGE', 'Generated narration did not cover the complete approved text.');
          }
          const samples = new Float32Array(sampleCount);
          let cursor = 0;
          for (const pcm of audioParts) { samples.set(pcm, cursor); cursor += pcm.length; }
          const normalized = normalizePcm(samples);
          const result = await writeNarrationWav(outputPath, normalized.samples, KOKORO_SAMPLE_RATE);
          segments.at(-1).endMs = result.durationMs;
          return {...result, segments, normalization: normalized.metadata, provider: metadata.provider, voice, language: 'en', speed: 1, synthesisSeconds: (performance.now() - started) / 1000, networkRequestsBlocked};
        } catch (cause) {
          if (cause.code?.startsWith('TTS_')) throw cause;
          throw speechError('TTS_SYNTHESIS_FAILED', 'Local Kokoro narration generation failed.', cause);
        } finally { busy = false; }
      },
      async dispose() {
        if (disposed) return;
        if (busy) throw speechError('TTS_PROVIDER_BUSY', 'Cannot dispose Kokoro while narration is running.');
        disposed = true;
        try { await tts.model.dispose(); } finally { restore(); }
      },
      get networkRequestsBlocked() { return networkRequestsBlocked; },
    };
  } catch (cause) {
    try { await tts?.model?.dispose(); } finally { restore(); }
    if (cause.code?.startsWith('TTS_')) throw cause;
    throw speechError('TTS_MODEL_LOAD_FAILED', 'Local Kokoro could not be loaded; verify the offline model and native CPU runtime.', cause);
  }
}
