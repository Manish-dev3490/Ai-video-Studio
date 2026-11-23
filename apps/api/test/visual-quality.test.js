import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {interFontHashes} from '../src/projects/inter-metrics.js';
import {assertVisualDensity, draftFromPlanning, validateDraft} from '../src/projects/validation.js';
import {assertVisualQuality} from '../src/projects/visual-quality.js';
import {flowchartLayout} from '../../../packages/video-engine/src/remotion/layout.js';

const fixture = seconds => JSON.parse(readFileSync(new URL(`../../../packages/video-engine/fixtures/event-loop-${seconds}.json`, import.meta.url), 'utf8'));
const graph = count => ({template: 'FLOWCHART', visualProps: {title: 'A clear sequence', nodes: Array.from({length: count}, (_, index) => ({id: 'n' + index, label: 'Step ' + (index + 1)})), edges: Array.from({length: count - 1}, (_, index) => ({from: 'n' + index, to: 'n' + (index + 1), label: 'Continue'}))}});

test('readability measurements remain bound to the actual pinned renderer fonts', () => {
  for (const weight of [400, 600, 700]) {
    const font = readFileSync(new URL(`../../../packages/video-engine/node_modules/@fontsource/inter/files/inter-latin-${weight}-normal.woff2`, import.meta.url));
    assert.equal(createHash('sha256').update(font).digest('hex'), interFontHashes[weight], 'Remeasure advances and rerun browser visual checks when changing fonts.');
  }
});

test('representative 30/60/90 plans retain all five templates and pass new visual capabilities without mutation', () => {
  const templates = new Set();
  for (const seconds of [30, 60, 90]) {
    const source = fixture(seconds), before = JSON.stringify(source);
    validateDraft(source);
    for (const scene of source.scenes) templates.add(scene.template);
    assert.equal(JSON.stringify(source), before);
  }
  assert.deepEqual([...templates].sort(), ['FLOWCHART', 'KEY_POINTS', 'STACK_QUEUE', 'STEPS', 'TITLE']);
});

test('accepted ordered chains occupy one actual renderer row with distinct connector corridors', () => {
  for (const count of [2, 3, 4]) {
    const scene = graph(count); assertVisualQuality({scenes: [scene]});
    const nodes = flowchartLayout(scene.visualProps.nodes);
    assert.equal(new Set(nodes.map(node => node.y)).size, 1);
    const corridors = scene.visualProps.edges.map((_, index) => ({left: nodes[index].x + nodes[index].width, right: nodes[index + 1].x}));
    for (const [index, corridor] of corridors.entries()) {
      assert.ok(corridor.right - corridor.left >= 47.99);
      if (index) assert.ok(corridors[index - 1].right < corridor.left);
    }
  }
});

test('back edges, duplicate/reciprocal paths, skipped nodes, branches and incomplete or reordered chains require review', () => {
  const cases = [
    value => value.visualProps.edges.push({from: 'n2', to: 'n0'}),
    value => {value.visualProps.edges[1] = {from: 'n0', to: 'n1'};},
    value => {value.visualProps.edges[1] = {from: 'n1', to: 'n0'};},
    value => {value.visualProps.edges[0] = {from: 'n0', to: 'n2'};},
    value => {value.visualProps.edges[1] = {from: 'n0', to: 'n2'};},
    value => {value.visualProps.edges[0] = {from: 'n0', to: 'n0'};},
    value => value.visualProps.edges.pop(),
    value => value.visualProps.edges.reverse(),
    value => value.visualProps.nodes.reverse(),
  ];
  for (const mutate of cases) {
    const scene = graph(3); mutate(scene); const before = JSON.stringify(scene);
    assert.throws(() => assertVisualQuality({scenes: [scene]}), error => error.code === 'LAYOUT_REVIEW_REQUIRED' && error.status === 422 && error.message.includes('STEPS'));
    assert.equal(JSON.stringify(scene), before);
  }
  assert.throws(() => assertVisualQuality({scenes: [graph(5)]}), {code: 'LAYOUT_REVIEW_REQUIRED'});
});

test('all supported-template labels retain bounded readable density including Unicode words and narrow card content', () => {
  const source = fixture(90);
  for (const scene of source.scenes) {
    scene.visualProps.title = 'Readable diagram headings remain short and easy to scan';
    if (scene.visualProps.subtitle) scene.visualProps.subtitle = 'A brief supporting sentence explains the main idea.';
    for (const key of ['steps', 'points']) if (scene.visualProps[key]) scene.visualProps[key] = scene.visualProps[key].map(() => 'Readable labels explain one idea with a concrete example.');
    if (scene.visualProps.items) scene.visualProps.items = scene.visualProps.items.map(() => 'A brief descriptive item');
  }
  assertVisualDensity(source);
  source.scenes[0].visualProps.title = 'A '.repeat(36).trim();
  assert.throws(() => assertVisualDensity(source), error => error.code === 'LAYOUT_TOO_DENSE' && error.details.maximumCharacters === 70);
  source.scenes[0].visualProps.title = '😀'.repeat(41);
  assert.throws(() => assertVisualDensity(source), {code: 'LAYOUT_TOO_DENSE'});
});

test('provider-invalid graph stays a sanitized draft error while manual edits receive actionable visual feedback', () => {
  const source = fixture(30), scene = source.scenes.find(item => item.template === 'FLOWCHART');
  scene.visualProps.edges.push({from: scene.visualProps.nodes.at(-1).id, to: scene.visualProps.nodes[0].id});
  const before = JSON.stringify(source);
  assert.throws(() => validateDraft(source), {code: 'LAYOUT_REVIEW_REQUIRED'});
  assert.throws(() => draftFromPlanning({schemaVersion: 1, targetDurationSec: 30, scenes: source.scenes}, {id: 'new-storyboard', projectId: source.projectId, settings: source.settingsSnapshot}), {code: 'AI_INVALID_OUTPUT'});
  assert.equal(JSON.stringify(source), before);
});

test('measured-width guard rejects the observed wide-glyph overflow while accepting normal words at the same character count', () => {
  const source = fixture(30);
  source.scenes[0].visualProps.title = ('W'.repeat(20) + ' ').repeat(3).trim();
  assert.throws(() => assertVisualDensity(source), error => error.code === 'LAYOUT_REVIEW_REQUIRED' && error.details.field.endsWith('.title'));
  source.scenes[0].visualProps.title = 'The water cycle brings rain from clouds back to the ground';
  assertVisualDensity(source);
  const cards = source.scenes.find(value => value.template === 'KEY_POINTS');
  cards.visualProps.points = Array.from({length: 4}, () => ('W'.repeat(20) + ' ').repeat(8).trim());
  assert.throws(() => assertVisualDensity(source), {code: 'LAYOUT_REVIEW_REQUIRED'});
});
