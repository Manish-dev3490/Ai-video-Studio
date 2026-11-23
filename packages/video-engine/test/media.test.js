import test from 'node:test';
import assert from 'node:assert/strict';
import {compareNarration, inspectPcmWave} from '../src/media.js';

const source = Int16Array.from({length: 48000}, (_, index) => Math.round(12000 * Math.sin(index * 0.043) * Math.sin(index * 0.00087)));

test('waveform verification tolerates encoder gain and a small sample offset', () => {
  const output = new Int16Array(72000);
  for (let index = 0; index < source.length; index++) output[index + 4807] = Math.round(source[index] * 0.8);
  const result = compareNarration(source, output, 4800);
  assert.equal(result.matched, true);
  assert.equal(result.lagSamples, 7);
});

test('waveform verification rejects an individually missing scene despite other audio', () => {
  const output = new Int16Array(120000);
  output.set(source, 70000);
  assert.equal(compareNarration(source, output, 4800).matched, false);
});

test('waveform verification rejects a missing narrated one-second window', () => {
  const output = new Int16Array(72000);
  output.set(source, 4800);
  output.fill(0, 28800, 52800);
  assert.equal(compareNarration(source, output, 4800).matched, false);
});

test('waveform verification rejects quiet narration even when correlation is perfect', () => {
  const output = new Int16Array(72000);
  for (let index = 0; index < source.length; index++) output[index + 4800] = Math.round(source[index] / 16);
  const result = compareNarration(source, output, 4800);
  assert.ok(result.correlation > 0.99);
  assert.equal(result.matched, false);
  assert.ok(result.levelMismatchWindows > 0);
});

test('the stereo export profile accounts for equal-power mono upmix but rejects extra gain loss', () => {
  const expectedDb = -3.010299956639812;
  const output = new Int16Array(72000);
  for (let index = 0; index < source.length; index++) output[index + 4800] = Math.round(source[index] / Math.sqrt(2));
  assert.equal(compareNarration(source, output, 4800, 24000, expectedDb).matched, true);
  for (let index = 0; index < output.length; index++) output[index] = Math.round(output[index] / 4);
  assert.equal(compareNarration(source, output, 4800, 24000, expectedDb).matched, false);
});

test('PCM inspection rejects empty or malformed media', () => {
  assert.throws(() => inspectPcmWave(Buffer.alloc(44)), {code: 'INVALID_AUDIO'});
});
