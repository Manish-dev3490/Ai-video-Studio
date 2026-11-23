import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateStoryboard, canonicalJson, canonicalHash, hashApprovedStoryboard} from '../src/contracts.js';

const fixture = (seconds = 30) => JSON.parse(readFileSync(new URL(`../fixtures/event-loop-${seconds}.json`, import.meta.url), 'utf8'));
const hasCode = (code) => (error) => error.code === code && error.retryable === false;

test('all three manual fixture plans use approved supported contracts', () => {
  for (const seconds of [30, 60, 90]) {
    const plan = fixture(seconds);
    assert.equal(validateStoryboard(plan), plan);
    assert.equal(plan.targetDurationSec, seconds);
  }
});

test('unapproved drafts cannot synthesize or render', () => {
  const plan = fixture();
  plan.status = 'DRAFT';
  plan.approvedAt = null;
  assert.throws(() => validateStoryboard(plan), hasCode('STORYBOARD_NOT_APPROVED'));
});

test('repeat template types require unique scene IDs, not unique kinds', () => {
  const plan = fixture(90);
  assert.equal(plan.scenes.filter((scene) => scene.template === 'STEPS').length, 2);
  validateStoryboard(plan);
  plan.scenes[1].sceneId = plan.scenes[0].sceneId;
  assert.throws(() => validateStoryboard(plan), hasCode('INVALID_STORYBOARD'));
});

test('schema rejects executable props, extra server fields and arbitrary media paths', () => {
  for (const mutate of [
    (plan) => { plan.scenes[0].visualProps.jsx = '<script>run()</script>'; },
    (plan) => { plan.ownerId = 'someone_else'; },
    (plan) => { plan.scenes[0].assetIds = ['../../private.wav']; },
  ]) {
    const plan = fixture();
    mutate(plan);
    assert.throws(() => validateStoryboard(plan), hasCode('INVALID_STORYBOARD'));
  }
});

test('known but untested languages and character references stay gated', () => {
  for (const mutate of [
    (plan) => { plan.settingsSnapshot.language = 'hi'; },
    (plan) => { plan.settingsSnapshot.characterAssetId = 'portrait_123'; },
    (plan) => { plan.scenes[0].assetIds = ['asset_123']; },
  ]) {
    const plan = fixture();
    mutate(plan);
    assert.throws(() => validateStoryboard(plan), hasCode('FEATURE_UNAVAILABLE'));
  }
});

test('flowchart references are semantically validated', () => {
  const plan = fixture();
  plan.scenes.find((scene) => scene.template === 'FLOWCHART').visualProps.edges[0].to = 'missing_node';
  assert.throws(() => validateStoryboard(plan), hasCode('INVALID_STORYBOARD'));
});

test('settings and selected duration must match, and caps do not authorize another profile', () => {
  const plan = fixture();
  plan.settingsSnapshot.durationSec = 60;
  assert.throws(() => validateStoryboard(plan), hasCode('INVALID_STORYBOARD'));
});

test('canonical hashes ignore object insertion order but retain Unicode and values', () => {
  assert.equal(canonicalHash({z: [1, 2], a: 'café 😀'}), canonicalHash({a: 'café 😀', z: [1, 2]}));
  assert.notEqual(canonicalHash({a: 'café'}), canonicalHash({a: 'cafe'}));
  assert.equal(canonicalJson({b: true, a: null}), '{"a":null,"b":true}');
});

test('approved content hash excludes trace timestamps and includes narration/settings', () => {
  const before = fixture();
  const after = structuredClone(before);
  after.updatedAt = '2026-11-22T12:00:00.000Z';
  assert.equal(hashApprovedStoryboard(before), hashApprovedStoryboard(after));
  after.scenes[0].narration += ' Keep the stack short.';
  assert.notEqual(hashApprovedStoryboard(before), hashApprovedStoryboard(after));
});

test('non-JSON data, cycles and sparse or augmented arrays cannot be hashed ambiguously', () => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [1, 2];
  delete sparse[1];
  sparse.extra = 2;
  for (const input of [NaN, undefined, new Date(), cycle, sparse, [undefined]]) {
    assert.throws(() => canonicalHash(input), hasCode('INVALID_JSON'));
  }
});
