import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedDurationFeedback, clearDurationRequests, durationCorrectionAvailable, durationPrivacyVersion, durationRequest, durationRevisionRequired, durationRoute, narrationWordCount, subscribeDurationPrivacy, uncertainDurationOutcome} from '../src/lib/duration.js';

const job = {id: '1'.repeat(24), projectId: '2'.repeat(24), storyboardId: '3'.repeat(24), approvedRevision: 2, status: 'FAILED', error: {code: 'DURATION_REVISION_REQUIRED'}};
const project = {id: job.projectId, currentStoryboardId: job.storyboardId, phase: 'REVIEW'};
const storyboard = {id: job.storyboardId, revision: 2, status: 'APPROVED'};
const feedback = {available: true, generationId: job.id, projectId: job.projectId, storyboardId: job.storyboardId, approvedRevision: 2, targetDurationSec: 60, measuredDurationSec: 72.16, narrationWords: 156, sceneCount: 5, suggestedNarrationWords: 129, direction: 'SHORTEN', correctedStoryboardId: null};

test('narration revision binds only a failed duration attempt to its exact owned source', () => {
  assert.equal(durationRevisionRequired(job), true);
  assert.deepEqual(durationRequest(project.id, job), {projectId: project.id, generationId: job.id, storyboardId: job.storyboardId, expectedRevision: 2});
  for (const invalid of [{...job, status: 'PROCESSING'}, {...job, projectId: '9'.repeat(24)}, {...job, approvedRevision: 0}, {...job, storyboardId: '../script'}, {...job, error: {code: 'RENDER_FAILED'}}]) assert.throws(() => durationRequest(project.id, invalid));
});
test('correction eligibility prevents dirty, historical, changed and running script mutation', () => {
  assert.equal(durationCorrectionAvailable({project, storyboard, job}), true);
  assert.equal(durationCorrectionAvailable({project, job}), true);
  for (const change of [{dirty: true}, {project: {...project, phase: 'RENDERING'}}, {project: {...project, currentStoryboardId: '4'.repeat(24)}}, {storyboard: {...storyboard, status: 'DRAFT'}}, {storyboard: {...storyboard, revision: 3}}, {job: {...job, projectId: '8'.repeat(24)}}]) assert.equal(durationCorrectionAvailable({project, storyboard, job, ...change}), false);
});
test('measured timing must bind generation, project and revision with finite bounded values', () => {
  assert.equal(checkedDurationFeedback(feedback, job), feedback);
  for (const change of [{available: false}, {generationId: '4'.repeat(24)}, {projectId: '5'.repeat(24)}, {storyboardId: '6'.repeat(24)}, {approvedRevision: 3}, {targetDurationSec: 45}, {measuredDurationSec: NaN}, {measuredDurationSec: Infinity}, {measuredDurationSec: -1}, {narrationWords: 0}, {sceneCount: 19}, {suggestedNarrationWords: 10.5}, {direction: 'AUTO_SPEEDUP'}, {correctedStoryboardId: 'https://unsafe.example'}]) assert.equal(checkedDurationFeedback({...feedback, ...change}, job), null);
});
test('word guidance counts only narration and recovery routing remains internal', () => {
  assert.equal(narrationWordCount([{narration: ' A clear\nsmall example. ', visualProps: {title: 'Ignored visual text'}}, {narration: 'Next idea.'}]), 6);
  assert.equal(narrationWordCount(null), 0);
  assert.equal(durationRoute(project.id, job.id), `/app/projects/${project.id}/review?durationSource=${job.id}`);
  assert.ok(durationRoute('https://outside.example', '../other').startsWith('/app/projects/https%3A%2F%2Foutside.example/'));
});
test('uncertain revision outcomes require saved-result checking rather than automatic new AI work', () => {
  for (const status of ['FETCH_ERROR', 'TIMEOUT_ERROR', 'PARSING_ERROR', 500, 503]) assert.equal(uncertainDurationOutcome({status}), true);
  for (const status of [401, 409, 422, 429]) assert.equal(uncertainDurationOutcome({status}), false);
});
test('privacy resets fence late revision callbacks even when the same owner signs back in', () => {
  const original = durationPrivacyVersion(); let resets = 0;
  const unsubscribe = subscribeDurationPrivacy(() => {resets++;});
  clearDurationRequests(); assert.equal(durationPrivacyVersion(), original + 1); assert.equal(resets, 1);
  unsubscribe(); clearDurationRequests(); assert.equal(resets, 1);
});
