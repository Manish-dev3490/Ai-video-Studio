import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {encodePcm16Wav, inspectPcm, normalizePcm, writeNarrationWav} from '../src/speech/audio.js';
import {assertContextFits, normalizeNarrationWhitespace, splitNarration} from '../src/speech/text.js';
import {createKokoroSpeechProvider} from '../src/speech/kokoro.js';

const tone = (length = 2400, amplitude = 0.3) => Float32Array.from({length}, (_, index) => amplitude * Math.sin(2 * Math.PI * 440 * index / 24000));

test('speech splitting retains complete wording and punctuation within bounded captions', () => {
  const text = 'Dr. Smith explains: "JavaScript runs one task at a time." The browser coordinates timers, while promise callbacks enter a separate microtask queue. This final sentence must also be retained without punctuation loss.';
  const chunks = splitNarration(text, 80);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 80));
  assert.equal(normalizeNarrationWhitespace(chunks.join(' ')), normalizeNarrationWhitespace(text));
});

test('speech text limits count Unicode code points and never cut an unbroken token', () => {
  assert.throws(() => splitNarration('word '.repeat(241)), {code: 'TTS_TEXT_TOO_LONG'});
  assert.throws(() => splitNarration('x'.repeat(241)), {code: 'TTS_TOKEN_TOO_LONG'});
  assert.throws(() => splitNarration('A\u0000B'), {code: 'TTS_INVALID_TEXT'});
  assert.throws(() => splitNarration('   '), {code: 'TTS_INVALID_TEXT'});
  const unicode = 'A clear explanation includes an emoji 😀 and still retains every character.';
  assert.equal(splitNarration(unicode).join(' '), unicode);
});

test('untruncated phoneme context must fit including special tokens', () => {
  assert.doesNotThrow(() => assertContextFits(512));
  assert.throws(() => assertContextFits(513), {code: 'TTS_CONTEXT_OVERFLOW'});
  assert.throws(() => assertContextFits(2), {code: 'TTS_CONTEXT_OVERFLOW'});
  assert.throws(() => assertContextFits(undefined), {code: 'TTS_CONTEXT_OVERFLOW'});
});

test('WAV uses exact mono PCM16 sample data and duration', () => {
  const samples = new Float32Array([-1, -0.5, 0, 0.5, 1]);
  const wav = encodePcm16Wav(samples, 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), samples.length * 2);
  assert.deepEqual(Array.from({length: 5}, (_, index) => wav.readInt16LE(44 + index * 2)), [-32768, -16384, 0, 16384, 32767]);
  assert.equal(inspectPcm(tone()).durationMs, 100);
});

test('silent corrupt and out-of-range narration are rejected', () => {
  assert.throws(() => inspectPcm(new Float32Array(100)), {code: 'TTS_SILENT_AUDIO'});
  assert.throws(() => inspectPcm(new Float32Array([0.2, NaN])), {code: 'TTS_INVALID_AUDIO'});
  assert.throws(() => inspectPcm(new Float32Array([0.2, Infinity])), {code: 'TTS_INVALID_AUDIO'});
  assert.throws(() => inspectPcm(new Float32Array([0.2, 1.01])), {code: 'TTS_CLIPPED_AUDIO'});
  assert.throws(() => inspectPcm(new Float32Array()), {code: 'TTS_INVALID_AUDIO'});
});

test('linear normalization reaches target without changing samples or timing', () => {
  const samples = tone();
  const normalized = normalizePcm(samples);
  assert.equal(normalized.samples.length, samples.length);
  assert.equal(normalized.metadata.sampleCountUnchanged, true);
  assert.ok(Math.abs(normalized.metadata.afterRmsDbfs + 20) < 0.001);
  assert.ok(normalized.metadata.afterPeakDbfs <= -1);
  assert.equal(inspectPcm(normalized.samples).durationMs, inspectPcm(samples).durationMs);
});

test('peak ceiling takes precedence over boosting a high-crest signal', () => {
  const samples = new Float32Array(24000);
  samples[12000] = 1;
  const normalized = normalizePcm(samples);
  assert.ok(normalized.metadata.afterPeakDbfs <= -1 + 0.00001);
  assert.ok(normalized.metadata.afterRmsDbfs < -20);
  assert.equal(normalized.samples.length, 24000);
});

test('narration writes refuse overwrite and non-WAV/relative output paths', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'ai-video-speech-test-'));
  try {
    const file = path.join(temp, 'scene.wav');
    const result = await writeNarrationWav(file, tone());
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    const before = await readFile(file);
    await assert.rejects(writeNarrationWav(file, tone()), {code: 'TTS_OUTPUT_EXISTS'});
    assert.deepEqual(await readFile(file), before);
    await assert.rejects(writeNarrationWav('relative.wav', tone()), {code: 'TTS_INVALID_OUTPUT'});
    await assert.rejects(writeNarrationWav(path.join(temp, 'scene.mp3'), tone()), {code: 'TTS_INVALID_OUTPUT'});
  } finally {
    const resolved = await realpath(temp);
    const parent = await realpath(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase() || !path.basename(resolved).startsWith('ai-video-speech-test-')) throw new Error('Unsafe speech-test cleanup target');
    await rm(resolved, {recursive: true, force: true});
  }
});

test('provider rejects network generation and unsupported profiles before model load', async () => {
  await assert.rejects(createKokoroSpeechProvider({offline: false}), {code: 'TTS_OFFLINE_REQUIRED'});
  await assert.rejects(createKokoroSpeechProvider({voice: 'unreviewed_voice'}), {code: 'TTS_UNSUPPORTED_PROFILE'});
  await assert.rejects(createKokoroSpeechProvider({dtype: 'fp32'}), {code: 'TTS_UNSUPPORTED_PROFILE'});
  await assert.rejects(createKokoroSpeechProvider({modelPath: 'https://example.com/model', cacheDir: 'cache'}), {code: 'TTS_INVALID_MODEL_PATH'});
});
