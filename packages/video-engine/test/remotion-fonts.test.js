import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPinnedFonts} from '../src/remotion/font-loading.js';

test('font readiness waits for all pinned weights and the FontFaceSet ready boundary', async () => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const styles = [];
  const fonts = {ready, load: async style => { styles.push(style); return [{}]; }, check: () => true};
  let complete = false;
  const pending = loadPinnedFonts(fonts).then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(styles, ['400 24px Inter', '600 24px Inter', '700 24px Inter']);
  assert.equal(complete, false);
  resolveReady();
  await pending;
  assert.equal(complete, true);
});

test('missing or failed font faces cannot silently become fallback-font readiness', async () => {
  await assert.rejects(loadPinnedFonts({ready: Promise.resolve(), load: async () => []}), /did not load/);
  await assert.rejects(loadPinnedFonts({ready: Promise.resolve(), load: async () => { throw new Error('Font decode failed'); }}), /Font decode failed/);
  await assert.rejects(loadPinnedFonts({ready: Promise.resolve(), load: async () => [{}], check: () => false}), /not ready for layout/);
});

test('unsupported browser font loading fails explicitly', async () => {
  await assert.rejects(loadPinnedFonts(null), /unavailable/);
});
