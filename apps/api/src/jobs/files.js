import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const invalid = () => Object.assign(new Error('The private export path is not safe.'), {code: 'ARTIFACT_INTEGRITY_FAILED'});

/** Resolve and reject every existing child junction before creating anything. */
export async function ensureDirectoryUnder(root, directory) {
  const canonicalRoot = await fs.realpath(root);
  const requested = path.resolve(directory);
  if (!inside(canonicalRoot, requested)) throw invalid();
  const segments = path.relative(canonicalRoot, requested).split(path.sep).filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {stat = await fs.lstat(current);}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {await fs.mkdir(current);} catch (failure) {if (failure.code !== 'EEXIST') throw failure;}
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    const real = await fs.realpath(current);
    if (!inside(canonicalRoot, real) || path.relative(current, real) !== '') throw invalid();
  }
  return current;
}

export async function copyOwnedExport(file, storageRoot) {
  await ensureDirectoryUnder(storageRoot, path.dirname(file.destination));
  await fs.copyFile(file.source, file.destination, constants.COPYFILE_EXCL);
  // Never claim an EEXIST/failed destination as ours. Cleanup additionally checks
  // its filesystem identity, so a later replacement is not removed either.
  file.copied = true;
  const stat = await fs.lstat(file.destination, {bigint: true});
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalid();
  file.destinationIdentity = {dev: stat.dev, ino: stat.ino};
}

export async function removeOwnedCopy(file, storageRoot) {
  if (!file.copied || !file.destinationIdentity) return false;
  try {
    await ensureDirectoryUnder(storageRoot, path.dirname(file.destination));
    const stat = await fs.lstat(file.destination, {bigint: true});
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== file.destinationIdentity.dev || stat.ino !== file.destinationIdentity.ino) return false;
    await fs.unlink(file.destination);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    // Refuse uncertain cleanup instead of following a replaced path. The
    // operator's private-file janitor can reconcile an unreferenced leftover.
    if (error.code === 'ARTIFACT_INTEGRITY_FAILED') return false;
    throw error;
  }
}
