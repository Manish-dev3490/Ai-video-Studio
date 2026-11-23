import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTimeline} from '../src/timeline.js';
import {validateTimeline} from '../src/contracts.js';

const fixture = () => JSON.parse(readFileSync(new URL('../fixtures/event-loop-30.json', import.meta.url), 'utf8'));
const measured = (storyboard, durations = [7000, 7000, 7000, 7400]) => storyboard.scenes.map((scene, index) => ({sceneId: scene.sceneId, durationMs: durations[index]}));
const hasCode = (code) => (error) => error.code === code && error.retryable === false;

test('measured audio produces contiguous windows and no clipped narration', () => {
  const storyboard = fixture();
  const before = JSON.stringify(storyboard);
  const timeline = buildTimeline({storyboard, audio: measured(storyboard)});
  assert.equal(timeline.durationInFrames, 900);
  assert.equal(JSON.stringify(storyboard), before);
  let cursor = 0;
  for (const scene of timeline.scenes) {
    assert.equal(scene.startFrame, cursor);
    assert.ok(scene.audioOffsetInFrames + Math.ceil(scene.measuredAudioDurationMs * 30 / 1000) <= scene.durationInFrames);
    cursor += scene.durationInFrames;
  }
  assert.equal(cursor, 900);
});

test('only a small bounded deficit receives pause padding', () => {
  const storyboard = fixture();
  const small = buildTimeline({storyboard, audio: measured(storyboard, [6750, 6750, 6750, 7150])});
  assert.equal(small.durationInFrames, 900);
  const largerButValid = buildTimeline({storyboard, audio: measured(storyboard, [6250, 6250, 6250, 6650])});
  assert.equal(largerButValid.durationInFrames, 812); // Each half-frame speech boundary rounds up, never down.
});

test('long or very short narration asks for a revised approved draft, without trimming', () => {
  const storyboard = fixture();
  for (const durations of [[10000, 10000, 10000, 10000], [4000, 4000, 4000, 4000]]) {
    assert.throws(() => buildTimeline({storyboard, audio: measured(storyboard, durations)}), hasCode('DURATION_REVISION_REQUIRED'));
  }
});

test('measured chunks preserve exact transcript and frame-quantized boundary order', () => {
  const storyboard = fixture();
  const audio = measured(storyboard);
  audio[0].segments = [
    {text: 'JavaScript runs one task at a time.', startMs: 0, endMs: 3001},
    {text: 'The event loop coordinates when waiting callbacks can run.', startMs: 3001, endMs: 7000},
  ];
  const timeline = buildTimeline({storyboard, audio});
  assert.equal(timeline.scenes[0].captionSegments.length, 2);
  assert.equal(timeline.scenes[0].captionSegments[0].endFrame, timeline.scenes[0].captionSegments[1].startFrame);
  assert.equal(timeline.scenes[0].captionSegments[1].endFrame, 216);
});

test('missing, duplicate, unknown, corrupt or overlapping narration metadata is rejected', () => {
  const storyboard = fixture();
  const variants = [
    measured(storyboard).slice(1),
    measured(storyboard).map((entry, index) => index === 1 ? {...entry, sceneId: storyboard.scenes[0].sceneId} : entry),
    measured(storyboard).map((entry, index) => index === 1 ? {...entry, sceneId: 'unknown'} : entry),
    measured(storyboard).map((entry, index) => index === 1 ? {...entry, durationMs: NaN} : entry),
    measured(storyboard).map((entry, index) => index === 0 ? {...entry, segments: {bad: true}} : entry),
    measured(storyboard).map((entry, index) => index === 0 ? {...entry, segments: [{text: storyboard.scenes[0].narration, startMs: 0, endMs: 9999}]} : entry),
  ];
  for (const audio of variants) assert.throws(() => buildTimeline({storyboard, audio}), hasCode('INVALID_AUDIO_METADATA'));
});

test('transcript mismatch is not silently accepted as aligned audio', () => {
  const storyboard = fixture();
  const audio = measured(storyboard);
  audio[0].segments = [{text: 'Different narration.', startMs: 0, endMs: 7000}];
  assert.throws(() => buildTimeline({storyboard, audio}), hasCode('INVALID_AUDIO_METADATA'));
});

test('large narration without measured segment boundaries is not given invented word timing', () => {
  const storyboard = fixture();
  storyboard.scenes[0].narration = 'A sentence about the event loop. '.repeat(12).trim();
  assert.throws(() => buildTimeline({storyboard, audio: measured(storyboard)}), hasCode('CAPTION_ALIGNMENT_REQUIRED'));
});

test('frame rate and pause parameters remain inside approved profile', () => {
  const storyboard = fixture();
  assert.throws(() => buildTimeline({storyboard, audio: measured(storyboard), fps: 24}), hasCode('INVALID_TIMELINE_PROFILE'));
  assert.throws(() => buildTimeline({storyboard, audio: measured(storyboard), leadInFrames: 90}), hasCode('INVALID_TIMELINE_PROFILE'));
});

test('published timelines cannot shift scene order, clip audio or change captions', () => {
  const storyboard = fixture();
  const timeline = buildTimeline({storyboard, audio: measured(storyboard)});
  for (const mutate of [
    (value) => { value.scenes[0].sceneId = 'another'; },
    (value) => { value.scenes[0].durationInFrames -= 30; },
    (value) => { value.scenes[0].captionSegments[0].text = 'Unapproved words'; },
  ]) {
    const changed = structuredClone(timeline);
    mutate(changed);
    assert.throws(() => validateTimeline(storyboard, changed), hasCode('INVALID_TIMELINE'));
  }
});
