import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTimeline} from '../src/timeline.js';
import {captionTrackFromTimeline, frameToMilliseconds, parseWebVtt, serializeWebVtt, validateWebVtt} from '../src/captions.js';

function sample() {
  const storyboard = JSON.parse(readFileSync(new URL('../fixtures/event-loop-30.json', import.meta.url), 'utf8'));
  const audio = storyboard.scenes.map((scene, index) => ({sceneId: scene.sceneId, durationMs: index === 3 ? 7400 : 7000}));
  return {storyboard, audio};
}
const hasCode = (code) => (error) => error.code === code;

test('WebVTT cues are derived from the exact canonical measured frame windows', () => {
  const {storyboard, audio} = sample();
  const timeline = buildTimeline({storyboard, audio});
  const text = serializeWebVtt({timeline});
  const result = validateWebVtt({timeline, text});
  assert.equal(result.cueCount, 4);
  assert.ok(text.startsWith('WEBVTT\n\n1\n00:00:00.200 --> 00:00:07.200\n'));
  assert.equal(result.cues[0].text, storyboard.scenes[0].narration);
  assert.equal(frameToMilliseconds(1, 30), 33);
  assert.equal(frameToMilliseconds(2, 30), 67);
  assert.equal(frameToMilliseconds(30, 30), 1000);
});

test('literal caption markup and cue arrows cannot inject WebVTT structure', () => {
  const {storyboard, audio} = sample();
  storyboard.scenes[0].narration = 'A --> B & <script> is literal text, not executable markup.';
  const timeline = buildTimeline({storyboard, audio});
  const text = serializeWebVtt({timeline});
  assert.ok(text.includes('A --&gt; B &amp; &lt;script&gt;'));
  assert.equal(parseWebVtt(text)[0].text, storyboard.scenes[0].narration);
});

test('sidecar validation rejects transcript or timing drift', () => {
  const {storyboard, audio} = sample();
  const timeline = buildTimeline({storyboard, audio});
  const text = serializeWebVtt({timeline});
  for (const modified of [text.replace('00:00:00.200', '00:00:00.201'), text.replace('JavaScript', 'Another language')]) {
    assert.throws(() => validateWebVtt({timeline, text: modified}), hasCode('INVALID_CAPTIONS'));
  }
  assert.equal(validateWebVtt({timeline, text: text.replace(/\n/g, '\r\n')}).valid, true);
});

test('untrusted raw cue markup and malformed timestamps are rejected by strict parser', () => {
  assert.throws(() => parseWebVtt('WEBVTT\n\n1\n00:00:00.100 --> 00:00:01.000\n<script>bad</script>\n'), hasCode('INVALID_CAPTIONS'));
  assert.throws(() => parseWebVtt('WEBVTT\n\n1\n00:99:00.100 --> 00:00:01.000\nBad timing\n'), hasCode('INVALID_CAPTIONS'));
});

test('caption serialization cannot move captions outside measured audio or enable untested language', () => {
  const {storyboard, audio} = sample();
  const timeline = buildTimeline({storyboard, audio});
  const invalid = structuredClone(timeline);
  invalid.scenes[0].captionSegments[0].endFrame += 10;
  assert.throws(() => serializeWebVtt({timeline: invalid}), hasCode('INVALID_CAPTIONS'));
  assert.throws(() => serializeWebVtt({timeline, language: 'hi'}), hasCode('FEATURE_UNAVAILABLE'));
  const track = captionTrackFromTimeline({timeline});
  assert.equal(track.format, 'WEBVTT');
  assert.equal(track.mimeType, 'text/vtt');
  assert.equal(track.cues.length, 4);
});
