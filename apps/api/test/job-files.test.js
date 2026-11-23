import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {copyOwnedExport, ensureDirectoryUnder, removeOwnedCopy} from '../src/jobs/files.js';
import {cleanupWorkerArtifacts} from '../src/jobs/worker.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
async function workspace(work) {
  const root = path.join(repo, 'var', 'job-files-test-' + randomUUID());
  await fs.mkdir(root, {recursive: true});
  try {await work(root);} finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(repo, 'var') + path.sep));
    await fs.rm(root, {recursive: true, force: true});
  }
}

test('failed exclusive copy never deletes a pre-existing export', () => workspace(async directory => {
  const storage = path.join(directory, 'storage'); await fs.mkdir(storage);
  const source = path.join(directory, 'source'); await fs.writeFile(source, 'new artifact');
  const destination = path.join(storage, 'existing.mp4'); await fs.writeFile(destination, 'pre-existing artifact');
  const file = {source, destination};
  await assert.rejects(() => copyOwnedExport(file, storage), {code: 'EEXIST'});
  assert.equal(await removeOwnedCopy(file, storage), false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'pre-existing artifact');
}));
test('copy cleanup removes only its own unchanged filesystem identity', () => workspace(async directory => {
  const storage = path.join(directory, 'storage'); await fs.mkdir(storage);
  const source = path.join(directory, 'source'); await fs.writeFile(source, 'new artifact');
  const file = {source, destination: path.join(storage, 'owned.mp4')};
  await copyOwnedExport(file, storage);
  await fs.rename(file.destination, path.join(storage, 'moved-owned.mp4'));
  await fs.writeFile(file.destination, 'replacement owned by another operation');
  assert.equal(await removeOwnedCopy(file, storage), false);
  assert.equal(await fs.readFile(file.destination, 'utf8'), 'replacement owned by another operation');
  const own = {source, destination: path.join(storage, 'own.vtt')}; await copyOwnedExport(own, storage);
  assert.equal(await removeOwnedCopy(own, storage), true);
  await assert.rejects(() => fs.access(own.destination), {code: 'ENOENT'});
}));
test('export child junctions are rejected before creating or deleting outside the storage root', {skip: process.platform !== 'win32'}, () => workspace(async directory => {
  const storage = path.join(directory, 'storage'), outside = path.join(directory, 'outside-storage');
  await fs.mkdir(storage); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(storage, 'exports'), 'junction');
  await assert.rejects(() => ensureDirectoryUnder(storage, path.join(storage, 'exports', 'new-generation')), {code: 'ARTIFACT_INTEGRITY_FAILED'});
  await assert.rejects(() => fs.access(path.join(outside, 'new-generation')), {code: 'ENOENT'});
  const destination = path.join(outside, 'preserve.mp4'); await fs.writeFile(destination, 'preserve');
  const stat = await fs.lstat(destination, {bigint: true});
  const file = {destination: path.join(storage, 'exports', 'preserve.mp4'), copied: true, destinationIdentity: {dev: stat.dev, ino: stat.ino}};
  assert.equal(await removeOwnedCopy(file, storage), false);
  assert.equal(await fs.readFile(destination, 'utf8'), 'preserve');
}));
test('completed intermediates expire after seven days or project deletion even without download receipts', () => workspace(async directory => {
  const workRoot = path.join(directory, 'jobs'); await fs.mkdir(workRoot);
  const now = new Date();
  const cases = [
    {name: 'expired', publication: new Date(now.getTime() - 8 * 86400000), live: true, expectedCleanup: true},
    {name: 'unexpired', publication: new Date(now.getTime() - 86400000), live: true, expectedCleanup: false},
    {name: 'deleted', publication: new Date(now.getTime() - 86400000), live: false, expectedCleanup: true},
  ];
  const jobs = [];
  for (const item of cases) {
    item.directory = path.join(workRoot, item.name, 'attempt-1-' + randomUUID().replaceAll('-', ''));
    await fs.mkdir(item.directory, {recursive: true}); await fs.writeFile(path.join(item.directory, 'private.wav'), 'synthetic private test evidence');
    jobs.push({_id: item.name, projectId: item.name, status: 'COMPLETED', completedAt: item.publication, updatedAt: item.publication, manifest: {attemptDirectories: [item.directory], deliveryVerifiedAt: null, publication: {verifiedPublishedAt: item.publication.toISOString(), expiresAt: new Date(item.publication.getTime() + 604800000).toISOString()}}});
  }
  const updated = [];
  const models = {GenerationJob: {find: () => ({select: () => ({lean: async () => jobs})}), updateOne: async filter => {updated.push(filter._id);}}, Project: {exists: async filter => cases.find(item => item.name === filter._id).live}};
  await cleanupWorkerArtifacts({models, config: {workerWorkRoot: workRoot}, now});
  assert.deepEqual(updated.sort(), ['deleted', 'expired']);
  for (const item of cases) {
    if (item.expectedCleanup) await assert.rejects(() => fs.access(item.directory), {code: 'ENOENT'});
    else await fs.access(item.directory);
  }
}));
