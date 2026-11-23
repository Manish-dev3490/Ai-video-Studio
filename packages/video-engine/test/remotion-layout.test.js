import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRenderProps, cardGrid, estimatedTextLines, fitFont, flowchartLayout, pageState, sceneProgress, stackState} from '../src/remotion/layout.js';

function fixture() {
  const scenes = ['scene_a', 'scene_b'].map(sceneId => ({sceneId, template: 'TITLE', narration: 'Approved narration.', visualProps: {title: 'Repeated template type'}, estimatedDurationSec: 15}));
  return {
    storyboard: {status: 'APPROVED', targetDurationSec: 30, settingsSnapshot: {mode: 'FACELESS', language: 'en', aspectRatio: '16:9', durationSec: 30}, scenes},
    timeline: {fps: 30, durationInFrames: 900, scenes: scenes.map((scene, index) => ({sceneId: scene.sceneId, startFrame: index * 450, durationInFrames: 450, audioOffsetInFrames: 6, measuredAudioDurationMs: 14000}))},
    audioSources: {scene_a: 'narration/scene_a.wav', scene_b: 'narration/scene_b.wav'},
  };
}

test('metadata follows the supplied measured timeline and permits repeated template types with distinct IDs', () => {
  const input = fixture();
  assert.deepEqual(assertRenderProps(input), {width: 1280, height: 720, fps: 30, durationInFrames: 900});
  input.storyboard.targetDurationSec = 60;
  input.storyboard.settingsSnapshot.durationSec = 60;
  input.timeline.durationInFrames = 1800;
  input.timeline.scenes.forEach((scene, index) => { scene.startFrame = index * 900; scene.durationInFrames = 900; });
  assert.equal(assertRenderProps(input).durationInFrames, 1800);
});

test('render boundary rejects unapproved input and disabled templates', () => {
  const input = fixture();
  input.storyboard.status = 'DRAFT';
  assert.throws(() => assertRenderProps(input), /approved storyboard/);
  input.storyboard.status = 'APPROVED';
  input.storyboard.scenes[0].template = 'CHARACTER_PRESENTER_2D';
  assert.throws(() => assertRenderProps(input), /not enabled/);
});

test('render boundary rejects duplicate IDs, discontinuous timing, or narration clipping', () => {
  const duplicate = fixture();
  duplicate.storyboard.scenes[1].sceneId = duplicate.storyboard.scenes[0].sceneId;
  assert.throws(() => assertRenderProps(duplicate), /unique/);
  const gap = fixture();
  gap.timeline.scenes[1].startFrame++;
  assert.throws(() => assertRenderProps(gap), /not canonical/);
  const clipping = fixture();
  clipping.timeline.scenes[0].measuredAudioDurationMs = 15000;
  assert.throws(() => assertRenderProps(clipping), /clipped/);
});

test('render boundary rejects arbitrary audio URLs, traversal and extra resources', () => {
  for (const source of ['https://example.com/narration.wav', '../narration/a.wav', 'narration/a.wav?token=secret', 'narration/a/b.wav']) {
    const input = fixture();
    input.audioSources.scene_a = source;
    assert.throws(() => assertRenderProps(input), /internally resolved/);
  }
  const extra = fixture();
  extra.audioSources.unused = 'narration/unused.wav';
  assert.throws(() => assertRenderProps(extra), /do not match/);
});

test('long lists paginate deterministically and retain the final page at the last frame', () => {
  assert.deepEqual(pageState(0, 8), {page: 0, pages: 2, start: 0, end: 4, progress: 0});
  assert.deepEqual(pageState(0.5, 8), {page: 1, pages: 2, start: 4, end: 8, progress: 0});
  assert.deepEqual(pageState(1, 8), {page: 1, pages: 2, start: 4, end: 8, progress: 1});
  assert.equal(sceneProgress(899, 900), 1);
});

test('maximum-card text is wrapped rather than truncated and fits the estimated card budget', () => {
  const grid = cardGrid(4);
  const text = 'M'.repeat(240);
  const size = fitFont(text, grid.cardWidth - 44, grid.cardHeight - 88, 30, 14, 1.2);
  assert.ok(estimatedTextLines(text, grid.cardWidth - 44, size) * size * 1.2 <= grid.cardHeight - 88);
  assert.ok(size >= 14 && size <= 30);
});

test('up to twelve graph nodes fit the fixed graph canvas without coordinate collisions', () => {
  for (let length = 2; length <= 12; length++) {
    const nodes = flowchartLayout(Array.from({length}, (_, index) => ({id: 'node_' + index, label: 'Node'})));
    assert.equal(new Set(nodes.map(node => `${node.x},${node.y}`)).size, length);
    for (const node of nodes) {
      assert.ok(node.x >= 0 && node.y >= 0);
      assert.ok(node.x + node.width <= 1152 + 1e-6);
      assert.ok(node.y + node.height <= 344 + 1e-6);
    }
  }
});

test('stack animation pushes in order, returns in reverse order, and ends empty', () => {
  assert.deepEqual(stackState(0, 3), {phase: 'PUSH', visible: 1, active: 0});
  assert.equal(stackState(0.5, 3).active, 2);
  assert.equal(stackState(0.6, 3).phase, 'RETURN');
  assert.equal(stackState(0.85, 3).active, 1);
  assert.deepEqual(stackState(1, 3), {phase: 'COMPLETE', visible: 0, active: 0});
});
