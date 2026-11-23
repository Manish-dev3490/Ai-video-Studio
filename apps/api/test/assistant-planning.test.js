import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {startLocalMongo} from '../../../scripts/local-mongo.mjs';
import {createStudioModels, initializeStudioModels} from '../src/studio-models.js';
import {createProjectServices} from '../src/projects/index.js';
import {planningPrompt} from '../src/projects/planner.js';
import {readAssistantContext} from '../src/assistant/index.js';
import {canonicalHash} from '../../../packages/video-engine/src/contracts.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = path.join(root, 'var/phase6-tests', 'planning-' + randomUUID());
const config = {geminiTimeoutMs: 1000, planningMaxAttempts: 1, assistantContextMessages: 12, assistantContextChars: 16000};
let mongo, connection, models, source;
const owner = () => String(new mongoose.Types.ObjectId());
const settings = () => structuredClone(source.settingsSnapshot);
const plan = () => ({schemaVersion: 1, targetDurationSec: 30, scenes: structuredClone(source.scenes)});
const input = () => ({title: 'Conversation planning integration', prompt: 'Plan a clear educational explainer.', settings: settings()});
before(async () => {
  const port = await new Promise(resolve => {const listener = net.createServer(); listener.listen(0, '127.0.0.1', () => {const value = listener.address().port; listener.close(() => resolve(value));});});
  source = JSON.parse(await fs.readFile(path.join(root, 'packages/video-engine/fixtures/event-loop-30.json'), 'utf8'));
  mongo = await startLocalMongo({directory, port, replicaSet: 'assistantPlanning'});
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/assistant_planning?replicaSet=assistantPlanning`, {serverSelectionTimeoutMS: 5000}).asPromise();
  models = createStudioModels(connection); await initializeStudioModels(models);
});
after(async () => {
  await connection?.close(); await mongo?.stop();
  for (let count = 0; mongo?.child.exitCode === null && count < 20; count++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(!mongo || mongo.child.exitCode !== null, 'The owned temporary database stopped before cleanup');
  assert.ok(path.resolve(directory).startsWith(path.resolve(root, 'var') + path.sep));
  await fs.rm(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
});
async function append(project, ownerId, messages) {
  await connection.transaction(async session => {
    await models.AssistantMessage.create(messages.map((content, index) => ({ownerId, projectId: project.id, role: index % 2 ? 'ASSISTANT' : 'USER', content, conversationRevision: index + 1, ...(index % 2 ? {suggestedSettings: {durationSec: 60}} : {})})), {session, ordered: true});
    await models.Project.updateOne({_id: project.id}, {$set: {assistantConversationRevision: messages.length}}).session(session);
  });
}

test('saved clarifications reach the planner while unaccepted suggestions cannot change settings', async () => {
  const user = owner(); let captured;
  const service = createProjectServices({connection, config, models, planner: async request => {captured = request; return plan();}});
  const project = await service.create(user, input());
  const text = ['Explain the water cycle for children.', 'We can use a simple cloud example and sixty seconds.', 'Keep thirty seconds and focus on evaporation.', 'I will use a child-friendly evaporation example.'];
  await append(project, user, text);
  const draft = await service.generate(user, project.id, {});
  assert.equal(captured.conversationRevision, 4);
  assert.deepEqual(captured.conversation.map(turn => turn.content), text);
  assert.equal(captured.settings.durationSec, 30);
  assert.equal(draft.targetDurationSec, 30);
  assert.equal((await service.read(user, project.id)).settings.durationSec, 30);
  const stored = await models.Storyboard.findById(draft.id).lean();
  assert.equal(stored.sourceConversationRevision, 4);
  assert.equal(stored.sourceConversationHash, canonicalHash({conversationRevision: 4, messages: captured.conversation}));
  assert.equal(Object.hasOwn(draft, 'sourceConversationRevision'), false, 'Canonical public storyboard DTO remains unchanged');
});

test('provider context is bounded without deleting the saved history', async () => {
  const user = owner(); const service = createProjectServices({connection, config, models, planner: async () => plan()});
  const project = await service.create(user, input());
  await append(project, user, Array.from({length: 30}, (_, index) => `Turn ${index + 1}. ` + 'A useful bounded explanation. '.repeat(45)));
  const stored = await models.Project.findById(project.id).lean();
  const context = await readAssistantContext({models, project: stored, config});
  assert.equal(context.conversationRevision, 30);
  assert.ok(context.messages.length <= 12);
  assert.ok(context.messages.reduce((count, row) => count + row.content.length, 0) <= 16000);
  assert.match(context.messages.at(-1).content, /^Turn 30\./u);
  assert.equal(await models.AssistantMessage.countDocuments({projectId: project.id}), 30);
  for (const message of context.messages) assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
});

test('script generation refuses an unsettled assistant turn before calling the planner', async () => {
  let calls = 0; const user = owner(); const service = createProjectServices({connection, config, models, planner: async () => {calls++; return plan();}});
  const project = await service.create(user, input());
  await models.Project.updateOne({_id: project.id}, {$set: {assistantLeaseToken: randomUUID(), assistantLeaseExpiresAt: new Date(Date.now() + 120000)}});
  await assert.rejects(() => service.generate(user, project.id, {}), {code: 'ASSISTANT_IN_PROGRESS'});
  assert.equal(calls, 0);
});

test('a changed conversation during planning fences the stale draft publication', async () => {
  const user = owner(); let begin, release;
  const started = new Promise(resolve => {begin = resolve;}); const gate = new Promise(resolve => {release = resolve;});
  const service = createProjectServices({connection, config, models, planner: async () => {begin(); await gate; return plan();}});
  const project = await service.create(user, input()); const pending = service.generate(user, project.id, {}); await started;
  await append(project, user, ['Use a new topic.', 'The next draft should reflect that clarification.']);
  release(); await assert.rejects(pending, {code: 'PROJECT_CHANGED'});
  assert.equal(await models.Storyboard.countDocuments({projectId: project.id}), 0);
  assert.equal((await models.Project.findById(project.id).lean()).planningToken, null);
});

test('obvious credentials are rejected before new project storage and legacy prompts cannot reach Gemini', async () => {
  const user = owner(); let calls = 0; const service = createProjectServices({connection, config, models, planner: async () => {calls++; return plan();}});
  const secret = 'AIza' + 'A'.repeat(35);
  await assert.rejects(() => service.create(user, {...input(), prompt: 'Use this API key ' + secret}), {code: 'SENSITIVE_INPUT'});
  assert.equal(await models.Project.countDocuments({ownerId: user}), 0);
  const legacy = await models.Project.create({...input(), ownerId: user, prompt: 'Use this API key ' + secret});
  await assert.rejects(() => service.generate(user, String(legacy._id), {}), {code: 'SENSITIVE_INPUT'});
  assert.equal(calls, 0);
  const safeProject = await service.create(user, input());
  await append(safeProject, user, ['A legacy message contains ' + secret, 'Never send credentials to the provider.']);
  await assert.rejects(() => service.generate(user, safeProject.id, {}), {code: 'SENSITIVE_INPUT'});
  assert.equal(calls, 0, 'Legacy/manual history is rechecked before storyboard planning');
});

test('planning prompt serializes recent inert conversation separately from authoritative settings', () => {
  const history = Array.from({length: 20}, (_, index) => ({role: index % 2 ? 'ASSISTANT' : 'USER', content: `Clarification ${index + 1}`, ownerId: 'never-send-this-field'}));
  const request = planningPrompt({prompt: 'A saved idea', settings: settings(), conversation: history, conversationRevision: 20});
  const data = JSON.parse(request.contents[0].parts[0].text);
  assert.equal(data.savedConversation.length, 12); assert.equal(data.conversationRevision, 20); assert.equal(data.settings.durationSec, 30);
  assert.equal(JSON.stringify(request).includes('never-send-this-field'), false);
  assert.match(request.systemInstruction.parts[0].text, /saved settings are authoritative/u);
  const unicode = history.slice(-12).map(turn => ({role: turn.role, content: '🌱'.repeat(1000)}));
  const unicodeRequest = planningPrompt({prompt: 'A saved idea', settings: settings(), conversation: unicode, conversationRevision: 20});
  assert.equal(JSON.parse(unicodeRequest.contents[0].parts[0].text).savedConversation.length, 12, 'Unicode context uses the same code-point budget as saved context provenance');
});
