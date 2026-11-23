import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGeminiPlanner, planningPrompt, planningResponseSchema} from '../src/projects/planner.js';
import {assertNarrationBudget, draftFromPlanning, publicStoryboard, settingsHash, validateDraft, validateProjectCreate, validateProjectPatch, validateRevision, validateSettings} from '../src/projects/validation.js';

const fixture = seconds => JSON.parse(readFileSync(new URL(`../../../packages/video-engine/fixtures/event-loop-${seconds}.json`, import.meta.url), 'utf8'));
const planning = value => ({schemaVersion: value.schemaVersion, targetDurationSec: value.targetDurationSec, scenes: value.scenes});
const config = {geminiApiKey: 'test-only-not-a-real-key', geminiModel: 'gemini-test-model', geminiTimeoutMs: 1000, planningMaxAttempts: 2};
const reply = value => new Response(JSON.stringify({candidates: [{finishReason: 'STOP', content: {parts: [{text: JSON.stringify(value)}]}}]}), {headers: {'content-type': 'application/json'}});
const wordArrays = (storyboard, targets) => {
  const words = storyboard.scenes.flatMap(scene => scene.narration.trim().split(/\s+/u));
  assert.equal(words.length, targets.reduce((total, count) => total + count, 0));
  let offset = 0;
  return Object.fromEntries(targets.map((count, index) => {const value = words.slice(offset, offset + count); offset += count; return ['scene' + (index + 1), value];}));
};
const validProject = () => ({title: 'Event loop', prompt: 'Explain the JavaScript event loop.', settings: fixture(30).settingsSnapshot});

test('project create/patch allowlist excludes owner, prompt patch and unavailable settings', () => {
  assert.equal(validateProjectCreate(validProject()).settings.characterAssetId, null);
  assert.throws(() => validateProjectCreate({...validProject(), ownerId: 'someone'}), {code: 'VALIDATION_FAILED'});
  assert.throws(() => validateProjectPatch({prompt: 'silently change the script'}), {code: 'VALIDATION_FAILED'});
  assert.throws(() => validateProjectPatch({}), {code: 'VALIDATION_FAILED'});
  assert.deepEqual(validateProjectPatch({settings: {}}), {settings: {}});
  for (const settings of [{language: 'hi'}, {aspectRatio: '9:16'}, {mode: 'CHARACTER_2D'}, {characterAssetId: '../private.wav'}]) assert.throws(() => validateSettings({...validProject().settings, ...settings}), {code: 'FEATURE_UNAVAILABLE'});
  assert.throws(() => validateProjectCreate({...validProject(), prompt: 'x'.repeat(2001)}), {code: 'VALIDATION_FAILED'});
  assert.throws(() => validateProjectCreate({...validProject(), title: 'a\u0000b'}), {code: 'VALIDATION_FAILED'});
});

test('settings canonicalization equates absent/null character selector and exact supported values', () => {
  const settings = validProject().settings;
  const without = {...settings}; delete without.characterAssetId;
  assert.equal(settingsHash(settings), settingsHash(without));
  assert.notEqual(settingsHash(settings), settingsHash({...settings, durationSec: 60}));
});

test('manual 30/60/90 plans pass canonical and measured-profile planning bounds', () => {
  for (const target of [30, 60, 90]) {
    const source = fixture(target);
    const draft = draftFromPlanning(planning(source), {id: 'server_storyboard', projectId: 'server_project', settings: source.settingsSnapshot, now: new Date('2026-11-21T12:00:00Z')});
    assert.equal(draft.status, 'DRAFT'); assert.equal(draft.revision, 1); assert.equal(draft.approvedAt, null);
    assert.equal(draft.id, 'server_storyboard'); assert.equal(draft.targetDurationSec, target);
    assertNarrationBudget(draft);
  }
});

test('planning cannot supply owner/approval metadata or use a different requested duration', () => {
  const source = fixture(30);
  const options = {id: 'server_storyboard', projectId: 'server_project', settings: source.settingsSnapshot};
  assert.throws(() => draftFromPlanning({...planning(source), status: 'APPROVED'}, options), {code: 'AI_INVALID_OUTPUT'});
  assert.throws(() => draftFromPlanning({...planning(source), ownerId: 'attacker'}, options), {code: 'AI_INVALID_OUTPUT'});
  assert.throws(() => draftFromPlanning({...planning(source), targetDurationSec: 60}, options), {code: 'AI_INVALID_OUTPUT'});
});

test('untrusted planning rejects executable props, disabled templates, duplicate IDs and invalid graph links', () => {
  const source = fixture(30);
  const options = {id: 'storyboard', projectId: 'project', settings: source.settingsSnapshot};
  for (const mutate of [
    value => {value.scenes[0].visualProps.code = 'run arbitrary code';},
    value => {value.scenes[0].template = 'CHARACTER_PRESENTER_2D';},
    value => {value.scenes[1].sceneId = value.scenes[0].sceneId;},
    value => {value.scenes.find(scene => scene.template === 'FLOWCHART').visualProps.edges[0].to = 'missing';},
  ]) {
    const value = planning(structuredClone(source)); mutate(value);
    assert.throws(() => draftFromPlanning(value, options), {code: 'AI_INVALID_OUTPUT'});
  }
});

test('initial 720p density guard rejects long labels and unbroken words before rendering', () => {
  const source = fixture(30);
  source.status = 'DRAFT'; source.approvedAt = null;
  source.scenes[0].visualProps.title = 'W'.repeat(41);
  assert.throws(() => validateDraft(source), {code: 'LAYOUT_TOO_DENSE'});
  source.scenes[0].visualProps.title = 'short '.repeat(14).trim();
  assert.throws(() => validateDraft(source), {code: 'LAYOUT_TOO_DENSE'});
});

test('approval budget rejects too-short narration without trimming or changing speed', () => {
  const source = fixture(30);
  for (const scene of source.scenes) scene.narration = 'Only a few words.';
  assert.throws(() => assertNarrationBudget(source), {code: 'NARRATION_BUDGET'});
  assert.equal(source.scenes[0].narration, 'Only a few words.');
});

test('revision requests require positive integers and expose no approval-side input fields', () => {
  for (const value of [0, -1, 1.5, '1']) assert.throws(() => validateRevision({expectedRevision: value}), {code: 'VALIDATION_FAILED'});
  assert.throws(() => validateRevision({expectedRevision: 1, status: 'APPROVED'}), {code: 'VALIDATION_FAILED'});
  assert.throws(() => validateRevision({expectedRevision: 1}, {edit: true}), {code: 'VALIDATION_FAILED'});
  assert.deepEqual(validateRevision({expectedRevision: 2}), {expectedRevision: 2});
});

test('public storyboard serialization omits hashes/owner internals and clones the scene list', () => {
  const source = fixture(30);
  const document = {...source, _id: source.id, ownerId: 'private-owner', contentHash: 'private-hash', hidden: true};
  const visible = publicStoryboard(document);
  assert.equal(visible.ownerId, undefined); assert.equal(visible.contentHash, undefined); assert.equal(visible.hidden, undefined);
  visible.scenes[0].narration = 'Different';
  assert.notEqual(source.scenes[0].narration, 'Different');
});

test('compact Gemini grammar allows only the five templates and no conditional schema state explosion', () => {
  const json = JSON.stringify(planningResponseSchema);
  assert.deepEqual(planningResponseSchema.properties.scenes.items.properties.template.enum, ['TITLE', 'STEPS', 'STACK_QUEUE', 'FLOWCHART', 'KEY_POINTS']);
  assert.equal(json.includes('$ref'), false); assert.equal(json.includes('allOf'), false);
  assert.equal(json.includes('anyOf'), false); assert.equal(json.includes('maxItems'), false);
  assert.equal(json.includes('CHARACTER_PRESENTER_2D'), false); assert.equal(json.includes('approvedAt'), false);
  assert.deepEqual(planningResponseSchema.properties.schemaVersion, {type: 'integer', enum: [1]});
});

test('Gemini sends credentials only in a header and returns completed JSON data', async () => {
  const source = fixture(30);
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async (url, options) => {
    calls++; assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
    assert.equal(url.includes(config.geminiApiKey), false);
    assert.equal(options.headers['x-goog-api-key'], config.geminiApiKey);
    const body = JSON.parse(options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 8192);
    assert.equal(JSON.stringify(body).includes(config.geminiApiKey), false);
    return reply(planning(source));
  }});
  assert.deepEqual(await planner({prompt: 'Explain a topic.', settings: source.settingsSnapshot}), planning(source));
  assert.equal(calls, 1);
});

test('underfilled provider narration receives one counted repair request before any draft can be saved', async () => {
  const source = fixture(30), short = planning(source); short.scenes = structuredClone(short.scenes);
  short.scenes.forEach(scene => {scene.narration = 'A brief explanation.';});
  const complete = planning(fixture(30)); complete.scenes[0].narration += ' Think carefully.';
  const repairedWords = wordArrays(complete, [17, 17, 17, 17]);
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async (url, options) => {
    calls++;
    if (calls === 2) {
      const request = JSON.parse(options.body), payload = JSON.parse(request.contents[0].parts[0].text);
      assert.equal(payload.narrationWordCorrection.previousWordCount, 12);
      assert.equal(payload.narrationWordCorrection.requestedWordCount, 68);
    }
    return reply(calls === 1 ? short : repairedWords);
  }});
  const output = await planner({prompt: 'Explain a topic.', settings: source.settingsSnapshot});
  assert.deepEqual(output.scenes.map(({narration, ...rest}) => rest), short.scenes.map(({narration, ...rest}) => rest));
  assert.deepEqual(output.scenes.map(scene => scene.narration), Object.values(repairedWords).map(words => words.join(' ')));
  assert.equal(output.scenes.map(scene => scene.narration).join(' ').split(/\s+/u).length, 68);
  assert.equal(calls, 2);
});

test('narration plans allocate the complete 30/60/90-second budget and preserve duration-revision scene counts', () => {
  for (const [duration, count, total] of [[30, 4, 68], [60, 5, 140], [90, 7, 210]]) {
    const request = planningPrompt({prompt: 'Explain the event loop.', settings: fixture(duration).settingsSnapshot});
    const payload = JSON.parse(request.contents[0].parts[0].text);
    assert.equal(payload.narrationPlan.length, count);
    assert.equal(payload.narrationPlan.reduce((sum, scene) => sum + scene.targetWords, 0), total);
    assert.deepEqual(payload.narrationPlan.map(scene => scene.sceneIndex), Array.from({length: count}, (_, index) => index + 1));
  }
  const scenes = fixture(60).scenes;
  const revision = {feedback: {targetDurationSec: 90, measuredDurationSec: 85, narrationWords: 200, suggestedNarrationWords: 211, direction: 'EXPAND'}, scenes};
  const request = planningPrompt({prompt: 'Explain the event loop.', settings: fixture(90).settingsSnapshot, durationRevision: revision});
  const payload = JSON.parse(request.contents[0].parts[0].text);
  assert.equal(payload.narrationPlan.length, scenes.length);
  assert.equal(payload.narrationPlan.reduce((sum, scene) => sum + scene.targetWords, 0), 211);
  assert.deepEqual(payload.durationRevision.scenes, scenes);
});

test('a 187-word 90-second response is revised from its actual narration to a valid 210-word draft', async () => {
  const complete = planning(fixture(90));
  complete.scenes[0].narration += ' This simple model helps explain everyday asynchronous JavaScript program behavior.';
  const rejected = structuredClone(complete);
  rejected.scenes[0].narration = rejected.scenes[0].narration.split(/\s+/u).slice(23).join(' ');
  const repairedWords = wordArrays(complete, [30, 30, 30, 30, 30, 30, 30]);
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async (url, options) => {
    calls++;
    const request = JSON.parse(options.body), payload = JSON.parse(request.contents[0].parts[0].text);
    if (calls === 2) {
      const correction = payload.narrationWordCorrection;
      assert.equal(correction.previousWordCount, 187); assert.equal(correction.requestedWordCount, 210);
      assert.equal(correction.priorNarration.length, 7);
      assert.equal(correction.priorNarration[0].narration, rejected.scenes[0].narration);
      assert.deepEqual(correction.priorNarration.map(scene => scene.sceneId), rejected.scenes.map(scene => scene.sceneId));
      assert.equal(correction.priorNarration.reduce((sum, scene) => sum + scene.previousWordCount, 0), 187);
      assert.equal(correction.priorNarration.reduce((sum, scene) => sum + scene.targetWords, 0), 210);
      assert.equal(correction.priorNarration.reduce((sum, scene) => sum + scene.wordDelta, 0), 23);
      assert.ok(correction.priorNarration.every(scene => Object.keys(scene).sort().join(',') === 'narration,previousWordCount,sceneId,sceneIndex,targetWords,wordDelta'));
      const schema = request.generationConfig.responseJsonSchema;
      assert.deepEqual(schema.required, ['scene1', 'scene2', 'scene3', 'scene4', 'scene5', 'scene6', 'scene7']);
      assert.equal(schema.additionalProperties, false);
      for (const key of schema.required) assert.deepEqual(schema.properties[key], {type: 'array', minItems: 30, maxItems: 30, items: {type: 'string'}});
      assert.match(request.systemInstruction.parts[0].text, /revise only factual English spoken narration/u);
      assert.equal(request.systemInstruction.parts[0].text.includes('Return the complete valid storyboard'), false);
    }
    return reply(calls === 1 ? rejected : repairedWords);
  }});
  const output = await planner({prompt: 'Explain the event loop.', settings: fixture(90).settingsSnapshot});
  assert.equal(calls, 2);
  assert.equal(output.scenes.map(scene => scene.narration).join(' ').split(/\s+/u).length, 210);
  assert.deepEqual(output.scenes.map(({narration, ...rest}) => rest), rejected.scenes.map(({narration, ...rest}) => rest));
  assert.equal(draftFromPlanning(output, {id: 'server_storyboard', projectId: 'server_project', settings: fixture(90).settingsSnapshot}).status, 'DRAFT');
});

test('narration-only repair rejects wrong keys, counts and unsafe or non-word tokens without local padding or more calls', async () => {
  const short = planning(fixture(30)); short.scenes.forEach(scene => {scene.narration = 'A brief explanation.';});
  const complete = planning(fixture(30)); complete.scenes[0].narration += ' Think carefully.';
  const valid = wordArrays(complete, [17, 17, 17, 17]);
  const mutations = [
    value => {delete value.scene1;}, value => {value.approved = true;}, value => {value.scene1.pop();}, value => {value.scene1.push('extra');}, value => {value.scene1 = 'not an array';},
    ...['', 'two words', ' leading', 'trailing ', 'line\nbreak', '\u0000word', '\ud800', '...', 'w'.repeat(129), 42, 'AIza' + 'a'.repeat(35)].map(token => value => {value.scene1[0] = token;}),
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid); mutate(invalid); let calls = 0;
    const planner = createGeminiPlanner({...config, planningMaxAttempts: 99}, {fetchImpl: async () => {calls++; return reply(calls === 1 ? short : invalid);}});
    await assert.rejects(planner({prompt: 'Explain a topic.', settings: fixture(30).settingsSnapshot}), {code: 'AI_INVALID_OUTPUT', status: 502});
    assert.equal(calls, 2);
  }
  assert.equal(short.scenes[0].narration, 'A brief explanation.');
});

test('narration repair preserves invalid first-candidate metadata for canonical rejection rather than laundering it', async () => {
  const short = planning(fixture(30)); short.scenes.forEach(scene => {scene.narration = 'A brief explanation.';}); short.scenes[0].untrustedMetadata = 'never-forward-this';
  const complete = planning(fixture(30)); complete.scenes[0].narration += ' Think carefully.';
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async (url, options) => {calls++; if (calls === 2) assert.equal(options.body.includes('never-forward-this'), false); return reply(calls === 1 ? short : wordArrays(complete, [17, 17, 17, 17]));}});
  const output = await planner({prompt: 'Explain a topic.', settings: fixture(30).settingsSnapshot});
  assert.equal(output.scenes[0].untrustedMetadata, 'never-forward-this');
  assert.throws(() => draftFromPlanning(output, {id: 'server_storyboard', projectId: 'server_project', settings: fixture(30).settingsSnapshot}), {code: 'AI_INVALID_OUTPUT'});
});

test('oversized rejected narration cannot create an unbounded repair context or extra provider call', async () => {
  const rejected = planning(fixture(60));
  rejected.scenes.forEach(scene => {scene.narration = 'Useful explanation '.repeat(200).trim();});
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async () => {calls++; return reply(rejected);}});
  await assert.rejects(planner({prompt: 'Explain the event loop.', settings: fixture(60).settingsSnapshot}), {code: 'AI_INVALID_OUTPUT', status: 502});
  assert.equal(calls, 1);
});

test('repeated narration-budget rejection remains bounded and never silently expands the script', async () => {
  const source = fixture(30), short = planning(source); short.scenes = structuredClone(short.scenes);
  short.scenes.forEach(scene => {scene.narration = 'A brief explanation.';});
  let calls = 0;
  const planner = createGeminiPlanner({...config, planningMaxAttempts: 99}, {fetchImpl: async () => {calls++; return reply(short);}});
  await assert.rejects(planner({prompt: 'Explain a topic.', settings: source.settingsSnapshot}), {code: 'AI_INVALID_OUTPUT', status: 502});
  assert.equal(calls, 2);
});

test('an exhausted provider daily quota returns a safe reset hint without a pointless second request', async () => {
  let calls = 0;
  const planner = createGeminiPlanner(config, {fetchImpl: async () => {calls++; return Response.json({error: {message: 'Private provider diagnostics must not escape', details: [{violations: [{quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20'}]}, {retryDelay: '43130.2s'}]}}, {status: 429});}});
  await assert.rejects(planner({prompt: 'Explain a topic.', settings: fixture(30).settingsSnapshot}), error => error.code === 'AI_DAILY_QUOTA_EXCEEDED' && error.status === 429 && error.details.retryAfterSeconds === 43131 && !error.message.includes('Private provider diagnostics'));
  assert.equal(calls, 1);
});

test('missing or unsafe Gemini configuration performs no provider request', async () => {
  let calls = 0;
  for (const settings of [{...config, geminiApiKey: ''}, {...config, geminiModel: 'model?key=secret'}]) {
    const planner = createGeminiPlanner(settings, {fetchImpl: async () => {calls++; return reply({});}});
    await assert.rejects(planner({prompt: 'Topic', settings: validProject().settings}), {code: 'AI_UNAVAILABLE'});
  }
  assert.equal(calls, 0);
});

test('Gemini retries only the bounded transient attempt and never reflects provider diagnostics', async () => {
  let calls = 0;
  const source = fixture(30);
  const planner = createGeminiPlanner({...config, planningMaxAttempts: 10}, {delay: async () => {}, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('upstream secret data', {status: 503}) : reply(planning(source));
  }});
  assert.deepEqual(await planner({prompt: 'Topic', settings: source.settingsSnapshot}), planning(source));
  assert.equal(calls, 2);
  const unavailable = createGeminiPlanner(config, {fetchImpl: async () => new Response('upstream secret data', {status: 401})});
  await assert.rejects(unavailable({prompt: 'Topic', settings: source.settingsSnapshot}), error => error.code === 'AI_UNAVAILABLE' && !error.message.includes('secret'));
});

test('Gemini blocks safety rejections, incomplete or oversized output without silent fallback', async () => {
  const source = fixture(30);
  for (const [body, code] of [
    [{promptFeedback: {blockReason: 'SAFETY'}}, 'CONTENT_REJECTED'],
    [{candidates: [{finishReason: 'MAX_TOKENS', content: {parts: [{text: '{}'}]}}]}, 'AI_INVALID_OUTPUT'],
    [{candidates: [{finishReason: 'STOP', content: {parts: [{text: 'not JSON'}]}}]}, 'AI_INVALID_OUTPUT'],
  ]) {
    const planner = createGeminiPlanner(config, {fetchImpl: async () => new Response(JSON.stringify(body))});
    await assert.rejects(planner({prompt: 'Topic', settings: source.settingsSnapshot}), {code});
  }
  const huge = createGeminiPlanner(config, {fetchImpl: async () => new Response('x'.repeat(262145))});
  await assert.rejects(huge({prompt: 'Topic', settings: source.settingsSnapshot}), {code: 'AI_INVALID_OUTPUT'});
});

test('Gemini timeout aborts the fetch and produces a sanitized retryable timeout', async () => {
  const planner = createGeminiPlanner(config, {fetchImpl: async (url, {signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Private transport diagnostic', 'AbortError')), {once: true}))});
  // Keep the event loop alive while AbortSignal.timeout's unref timer fires.
  const keeper = setInterval(() => {}, 1000);
  try { await assert.rejects(planner({prompt: 'Topic', settings: validProject().settings}), error => error.code === 'AI_TIMEOUT' && error.status === 504 && !error.message.includes('Private')); }
  finally { clearInterval(keeper); }
});
