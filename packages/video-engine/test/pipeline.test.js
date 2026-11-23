import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {prepareVideo, renderPrepared} from '../src/index.js';
import {parseRenderArguments} from '../scripts/render.js';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(engineRoot, '../..');
const digest = content => createHash('sha256').update(content).digest('hex');
const readFixture = async () => JSON.parse(await fsp.readFile(path.join(engineRoot, 'fixtures/event-loop-30.json'), 'utf8'));

async function privateTemporary(testContext) {
  const parent = await fsp.realpath(os.tmpdir());
  const directory = await fsp.mkdtemp(path.join(parent, 'video-engine-pipeline-'));
  testContext.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('video-engine-pipeline-'));
    await fsp.rm(resolved, {recursive: true, force: true});
  });
  return directory;
}

test('CLI requires approved-input preparation or an explicit existing-preparation render', () => {
  const args = parseRenderArguments(['--input', 'approved.json', '--output-dir', 'fresh-run', '--prepare-only']);
  assert.equal(args.prepareOnly, true);
  assert.ok(path.isAbsolute(args.input));
  assert.ok(path.isAbsolute(args.outputDir));
  assert.equal(parseRenderArguments(['--output-dir', 'prepared-run', '--render-only']).renderOnly, true);
  for (const input of [[], ['--skip-tts'], ['--output-dir', 'run'], ['--input', 'a', '--output-dir', 'b', '--prepare-only', '--render-only'], ['--input', 'a', '--output-dir', 'b', '--output-dir', 'c'], ['--output-dir', 'a', '--render-only', '--input', 'b'], ['--output-dir', 'a', '--render-only', '--model-dir', 'b'], ['--input', '--output-dir', 'a']]) {
    assert.throws(() => parseRenderArguments(input), /INVALID_ARGUMENTS/u);
  }
});

test('unapproved input is rejected before creating files or loading a speech model', async testContext => {
  const directory = await privateTemporary(testContext);
  const storyboard = await readFixture();
  storyboard.status = 'DRAFT';
  storyboard.approvedAt = null;
  const output = path.join(directory, 'must-stay-absent');
  await assert.rejects(prepareVideo({storyboard, outputDir: output, modelPath: path.join(directory, 'missing-model')}), error => error.code === 'STORYBOARD_NOT_APPROVED');
  await assert.rejects(fsp.access(output), error => error.code === 'ENOENT');
});

test('preserved repository directories cannot be selected for output', async () => {
  for (const name of ['docs', 'review', 'video-engine-poc', '.git']) {
    await assert.rejects(renderPrepared({outputDir: path.join(repository, name, 'forbidden-test-run'), browserExecutable: process.execPath}), error => error.code === 'PROTECTED_OUTPUT_DIRECTORY');
  }
});

test('a junction into a preserved directory is rejected before setup or parent creation', async testContext => {
  const directory = await privateTemporary(testContext);
  const storyboard = await readFixture();
  for (const name of ['docs', 'review', 'video-engine-poc', '.git']) {
    const target = path.join(repository, name);
    const alias = path.join(directory, 'alias-' + name.replace('.', ''));
    try { await fsp.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { testContext.skip('This OS/account cannot create a test directory junction.'); return; }
      throw error;
    }
    const missingParent = 'must-not-create-' + path.basename(directory);
    const protectedParent = path.join(target, missingParent);
    await assert.rejects(fsp.access(protectedParent), error => error.code === 'ENOENT');
    await assert.rejects(prepareVideo({storyboard, outputDir: path.join(alias, missingParent, 'nested', 'run'), modelPath: path.join(directory, 'model-not-present')}), error => error.code === 'PROTECTED_OUTPUT_DIRECTORY');
    await assert.rejects(fsp.access(protectedParent), error => error.code === 'ENOENT');
  }
});

test('an existing final video is preserved without starting another renderer', async testContext => {
  const directory = await privateTemporary(testContext);
  const video = path.join(directory, 'video.mp4');
  await fsp.writeFile(video, 'existing-private-output', {flag: 'wx'});
  await assert.rejects(renderPrepared({outputDir: directory, browserExecutable: process.execPath}), error => error.code === 'OUTPUT_ALREADY_PUBLISHED');
  assert.equal(await fsp.readFile(video, 'utf8'), 'existing-private-output');
  await assert.rejects(fsp.access(path.join(directory, 'render.lock')), error => error.code === 'ENOENT');
});

test('changed prepared content fails its checksum before browser launch and releases its lock', async testContext => {
  const directory = await privateTemporary(testContext);
  const original = JSON.stringify(await readFixture());
  const changed = JSON.parse(original);
  changed.scenes[0].narration = 'Changed after approval.';
  await fsp.writeFile(path.join(directory, 'storyboard.json'), JSON.stringify(changed), {flag: 'wx'});
  await fsp.writeFile(path.join(directory, 'preparation.json'), JSON.stringify({preparationVersion: 1, executionMode: 'LOCAL_QA', storyboardFileSha256: digest(original)}), {flag: 'wx'});
  await assert.rejects(renderPrepared({outputDir: directory, browserExecutable: process.execPath}), error => error.code === 'PREPARATION_INTEGRITY_FAILED');
  await assert.rejects(fsp.access(path.join(directory, 'render.lock')), error => error.code === 'ENOENT');
  await assert.rejects(fsp.access(path.join(directory, 'video.mp4')), error => error.code === 'ENOENT');
});

test('only the tested CPU render concurrency and an existing installed browser are accepted', async testContext => {
  const directory = await privateTemporary(testContext);
  await assert.rejects(renderPrepared({outputDir: directory, browserExecutable: process.execPath, concurrency: 2}), error => error.code === 'UNSUPPORTED_CONCURRENCY');
  await assert.rejects(renderPrepared({outputDir: directory, browserExecutable: path.join(directory, 'browser-not-installed')}), error => error.code === 'BROWSER_REQUIRED');
});

for (const metadataName of ['speech-metadata.json', 'public/speech-metadata.json']) {
  test(`private/legacy metadata checksum is enforced for ${metadataName}`, async testContext => {
    const directory = await privateTemporary(testContext);
    await fsp.mkdir(path.join(directory, 'public'));
    const files = {'storyboard.json': JSON.stringify(await readFixture()), 'timeline.json': '{}', 'input-props.json': '{}', 'captions.vtt': 'WEBVTT\n\n', 'model-manifest.json': '{}', [metadataName]: '{"modified":true}'};
    for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(directory, name), content, {flag: 'wx'});
    const preparation = {preparationVersion: 1, executionMode: 'LOCAL_QA', storyboardFileSha256: digest(files['storyboard.json']), timelineFileSha256: digest(files['timeline.json']), inputPropsSha256: digest(files['input-props.json']), captionSha256: digest(files['captions.vtt']), modelManifestSha256: digest(files['model-manifest.json']), speechMetadataSha256: digest('{"original":true}')};
    if (metadataName === 'speech-metadata.json') preparation.speechMetadataPath = metadataName;
    await fsp.writeFile(path.join(directory, 'preparation.json'), JSON.stringify(preparation), {flag: 'wx'});
    await assert.rejects(renderPrepared({outputDir: directory, browserExecutable: process.execPath}), error => error.code === 'PREPARATION_INTEGRITY_FAILED');
    await assert.rejects(fsp.access(path.join(directory, 'render.lock')), error => error.code === 'ENOENT');
  });
}
