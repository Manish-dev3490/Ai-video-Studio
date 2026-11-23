import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseRange, validExportPair, privateAssetPath} from '../src/media.js';

test('Single byte ranges include bounded, open-ended and suffix forms', () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange('bytes=0-31', 100), {start: 0, end: 31});
  assert.deepEqual(parseRange('bytes=20-', 100), {start: 20, end: 99});
  assert.deepEqual(parseRange('bytes=-20', 100), {start: 80, end: 99});
  assert.deepEqual(parseRange('bytes=0-999', 100), {start: 0, end: 99});
  for (const value of ['bytes=100-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=0-2,5-6', 'other=0-4', 'bytes=9007199254740993-']) assert.throws(() => parseRange(value, 100), {status: 416});
});

test('Publication pairs bind owner, project, generation, kind, MIME and storage identity', () => {
  const job = {_id: '1'.repeat(24), projectId: '2'.repeat(24), ownerId: '3'.repeat(24), outputAssetId: '4'.repeat(24), captionAssetId: '5'.repeat(24)};
  const pair = [['VIDEO_EXPORT', 'video/mp4', job.outputAssetId, 'mp4'], ['CAPTION_TRACK', 'text/vtt', job.captionAssetId, 'vtt']].map(([kind, mimeType, _id, extension]) => ({_id, kind, mimeType, generationId: job._id, projectId: job.projectId, ownerId: job.ownerId, byteSize: 100, storage: {provider: 'LOCAL', key: `exports/${job._id}/${_id}.${extension}`}}));
  assert.equal(validExportPair(job, pair), true);
  for (const mutate of [copy => {copy[0].kind = 'CAPTION_TRACK';}, copy => {copy[1].mimeType = 'video/mp4';}, copy => {copy[0].ownerId = '6'.repeat(24);}, copy => {copy[1].storage.key = pair[0].storage.key;}, copy => {copy[1].byteSize = 0;}]) {
    const changed = structuredClone(pair); mutate(changed); assert.equal(validExportPair(job, changed), false);
  }
  assert.equal(validExportPair({...job, outputAssetId: job.captionAssetId, captionAssetId: job.outputAssetId}, pair), false);
});

test('Private media keys cannot escape through path traversal, drive paths or junctions', async () => {
  const allowed = path.resolve('var/phase4-media-tests');
  const root = path.join(allowed, randomUUID());
  const storage = path.join(root, 'storage');
  const outside = path.join(root, 'outside');
  const generation = '1'.repeat(24), asset = '2'.repeat(24);
  await fs.mkdir(path.join(storage, 'exports'), {recursive: true});
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, asset + '.mp4'), 'private fixture');
  try {
    for (const key of ['../../.env', 'C:/Windows/file.mp4', 'exports/../' + asset + '.mp4', 'exports/' + generation + '/' + asset + '.exe']) await assert.rejects(privateAssetPath(storage, key), {status: 404});
    await fs.symlink(outside, path.join(storage, 'exports', generation), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(privateAssetPath(storage, `exports/${generation}/${asset}.mp4`), {status: 404});
    assert.equal(await fs.readFile(path.join(outside, asset + '.mp4'), 'utf8'), 'private fixture');
  } finally {
    const target = path.resolve(root);
    if (!target.startsWith(allowed + path.sep)) throw new Error('Unsafe test cleanup path');
    await fs.rm(target, {recursive: true, force: true});
  }
});
