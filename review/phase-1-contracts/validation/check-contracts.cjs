// Review-only checks. This file is not imported by the prototype or an app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');

const draftRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(draftRoot, '../..');
const Ajv = require(path.join(repoRoot, 'video-engine-poc/node_modules/schema-utils/node_modules/ajv/dist/2020')).default;
const addFormats = require(path.join(repoRoot, 'video-engine-poc/node_modules/ajv-formats'));
const checks = [], examples = [], semanticExamples = [], documents = new Map();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pointerEscape = value => value.replace(/~/g, '~0').replace(/\//g, '~1');
function record(name, passed, detail) { checks.push({name, passed: Boolean(passed), ...(detail ? {detail} : {})}); }
function filesUnder(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
function visit(value, callback, pointer = '') {
  callback(value, pointer);
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, callback, pointer + '/' + pointerEscape(key));
}
function load(file) {
  file = path.resolve(file);
  if (!documents.has(file)) documents.set(file, read(file));
  return documents.get(file);
}
function resolve(reference, fromFile) {
  const url = new URL(reference, pathToFileURL(fromFile));
  if (url.protocol !== 'file:') throw new Error(`Remote $ref is not allowed in offline draft checks: ${reference}`);
  const fragment = decodeURIComponent(url.hash.slice(1));
  url.hash = '';
  const file = fileURLToPath(url);
  const relative = path.relative(draftRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Reference leaves draft directory: ${reference}`);
  let value = load(file);
  if (fragment && !fragment.startsWith('/')) throw new Error(`Only JSON Pointer fragments are supported: ${reference}`);
  for (const key of fragment ? fragment.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')) : []) {
    if (!value || !Object.hasOwn(value, key)) throw new Error(`Unresolved reference: ${reference}`);
    value = value[key];
  }
  return {value, file};
}
function dereference(value, fromFile) {
  for (let depth = 0; value?.$ref; depth++) {
    if (depth > 30) throw new Error('Reference cycle while inspecting OpenAPI object');
    const resolved = resolve(value.$ref, fromFile);
    value = resolved.value;
    fromFile = resolved.file;
  }
  return value;
}

const specFile = path.join(draftRoot, 'openapi.json');
const sceneFile = path.join(draftRoot, 'schemas/scene.schema.json');
const jobFile = path.join(draftRoot, 'schemas/job.schema.json');
for (const file of filesUnder(draftRoot).filter(file => file.endsWith('.json') && !file.startsWith(__dirname + path.sep))) {
  try { load(file); record('JSON parses: ' + path.relative(draftRoot, file), true); }
  catch (error) { record('JSON parses: ' + path.relative(draftRoot, file), false, error.message); }
}
const spec = load(specFile), scene = load(sceneFile), job = load(jobFile);
const policy = load(path.join(draftRoot, 'approved-policy.json'));
const decisions = load(path.join(draftRoot, 'decisions.json'));
const lifecycle = load(path.join(draftRoot, 'job-transitions.json'));
let referenceCount = 0;
for (const [file, document] of [...documents]) {
  visit(document, value => {
    if (value && typeof value === 'object' && typeof value.$ref === 'string') {
      referenceCount++;
      try { resolve(value.$ref, file); }
      catch (error) { record('Local reference resolves: ' + path.relative(draftRoot, file) + ' ' + value.$ref, false, error.message); }
    }
  });
}
record('All local references resolve', !checks.some(check => check.name.startsWith('Local reference resolves:') && !check.passed), {referenceCount});

const expectedOperations = [
  'GET /auth/csrf', 'POST /auth/signup', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout', 'GET /auth/me', 'GET /health',
  'POST /projects', 'GET /projects', 'GET /projects/{projectId}', 'PATCH /projects/{projectId}', 'DELETE /projects/{projectId}',
  'POST /assistant/messages', 'GET /projects/{projectId}/assistant/messages',
  'POST /projects/{projectId}/storyboards/generate', 'GET /projects/{projectId}/storyboards/current',
  'GET /projects/{projectId}/storyboards/{storyboardId}', 'PATCH /projects/{projectId}/storyboards/{storyboardId}',
  'POST /projects/{projectId}/storyboards/{storyboardId}/approve', 'POST /projects/{projectId}/storyboards/{storyboardId}/fork',
  'POST /projects/{projectId}/generations', 'GET /projects/{projectId}/generations', 'GET /generations/{generationId}',
  'POST /generations/{generationId}/cancel', 'POST /generations/{generationId}/retry',
  'POST /assets/uploads', 'GET /assets/{assetId}', 'GET /assets/{assetId}/download', 'DELETE /assets/{assetId}',
  'POST /reports', 'GET /usage', 'GET /capabilities'
].sort();
const operations = [], operationIds = new Set(), schemaPointers = new Map();
record('OpenAPI 3.1.0 updated draft version', spec.openapi === '3.1.0' && spec.info?.version === '1.0.1-draft.2');
record('Updated draft review status', spec['x-review-status'] === 'DRAFT_UPDATED_WITH_APPROVED_DECISIONS');
record('API base remains /api/v1', spec.servers?.some(server => server.url === '/api/v1'));
record('No bearer authentication scheme', !Object.values(spec.components?.securitySchemes || {}).some(scheme => scheme.type === 'http' && scheme.scheme === 'bearer'));
const sameSet = (left, right) => JSON.stringify([...(left || [])].sort()) === JSON.stringify([...(right || [])].sort());
record('All twelve recommendations approved without authorizing implementation', decisions.status === 'APPROVED_RECOMMENDATIONS' && decisions.decisions?.length === 12 && decisions.decisions.every(item => item.status === 'APPROVED' && item.approvedOn === '2026-11-21') && decisions.implementationAuthorized === false);
record('Approved policy has contract-only scope', policy.status === 'APPROVED_FOR_PHASE_1_CONTRACT_UPDATE' && policy.approvedOn === '2026-11-21' && policy.implementationAuthorized === false && policy.approvedDocumentsAmended === false);
for (const [label, document] of [['scene', scene], ['job', job], ['lifecycle', lifecycle]]) record('Updated approved-decision draft marker: ' + label, document['x-review-status'] === 'DRAFT_UPDATED_WITH_APPROVED_DECISIONS');
record('Canonical nine-template registry agrees with policy', sameSet(scene.$defs.TemplateId.enum, policy.initialProfile.knownTemplateRegistry) && policy.initialProfile.knownTemplateRegistry.length === 9);
record('Initial five templates remain subject to tests', sameSet(scene['x-template-availability-policy']?.initialAfterTesting, policy.initialProfile.firstTemplatesToDevelopAndTest) && policy.initialProfile.firstTemplatesToDevelopAndTest.length === 5 && policy.initialProfile.templateActivationRequiresTests === true);
record('Legacy scene aliases are not silently accepted', policy.initialProfile.legacyAliasesAccepted === false && Object.values(scene['x-review-alias-map'] || {}).every(item => item.automaticAcceptance === false));
record('Approved initial scene limits', scene.$defs.SceneList.minItems === 2 && scene.$defs.SceneList.maxItems === 18 && policy.limits.scenes.minimum === 2 && policy.limits.scenes.maximum === 18);
record('Approved prompt and title caps', spec.components.schemas.ProjectCreate.properties.prompt.maxLength === 2000 && spec.components.schemas.ProjectCreate.properties.title.maxLength === 120 && scene.$defs.TitleProps.properties.title.maxLength === 120 && policy.limits.promptMaxCharacters === 2000 && policy.limits.titleMaxCharacters === 120);
record('Shared opaque identifiers remain canonical', job.$defs.OpaqueId.$ref === './scene.schema.json#/$defs/OpaqueId' && spec.components.schemas.OpaqueId.$ref === './schemas/scene.schema.json#/$defs/OpaqueId');
record('Measured 720p 30 FPS profile and five-second tolerance', policy.initialProfile.output.width === 1280 && policy.initialProfile.output.height === 720 && policy.timing.fps === 30 && policy.timing.initialToleranceSec === 5 && scene.$defs.RenderTimeline.properties.fps.const === 30 && scene['x-export-profile']?.width === 1280 && scene['x-export-profile']?.height === 720 && scene['x-export-profile']?.targetToleranceSec === 5);
record('No speech clipping speedup or scene overlap', policy.timing.silentSpeechClippingAllowed === false && policy.timing.unnaturalSpeedupAllowed === false && policy.timing.sceneOverlap === false && policy.timing.audioFrameCountRounding === 'CEILING');
record('Clean MP4 and private WebVTT sidecar policy', policy.captions.videoExportMode === 'CLEAN_MP4' && policy.captions.mp4AloneContainsCaptions === false && policy.captions.format === 'WEBVTT' && policy.captions.mimeType === 'text/vtt' && policy.captions.browserToggle === true && policy.captions.burnedInExport === 'DEFERRED');
record('Caption asset kind and MIME type are documented', spec.components.schemas.MediaAsset.properties.kind.enum.includes('CAPTION_TRACK') && spec.components.schemas.MediaAsset.properties.mimeType.enum.includes('text/vtt') && Boolean(scene.$defs.WebVttCaptionTrack));
record('Generation publication requires separate caption reference', job.$defs.Generation.required.includes('captionAssetId') && job.$defs.PublishedExportManifest.required.includes('captionArtifact') && job.$defs.PublishedExportManifest.required.includes('videoArtifact'));
record('Caption delivery reuses authorized asset route', policy.captions.deliveryRoute === '/api/v1/assets/{assetId}/download' && policy.captions.newCaptionRouteRequired === false && Boolean(spec.paths['/assets/{assetId}/download'].get.responses['200'].content['text/vtt']) && Boolean(spec.paths['/assets/{assetId}/download'].get.responses['206'].content['text/vtt']));
record('Initial voice and visual profile remain controlled', sameSet(policy.initialProfile.languages, ['en']) && sameSet(policy.initialProfile.modes, ['FACELESS']) && sameSet(policy.initialProfile.aspectRatios, ['16:9']) && policy.initialProfile.speech.preferredProvider === 'KOKORO' && policy.initialProfile.speech.execution === 'LOCAL' && policy.initialProfile.speech.voiceCount === 1 && policy.initialProfile.speech.publicVoiceSelector === false && policy.initialProfile.speech.automaticCloudFallback === false && !Object.hasOwn(scene.$defs.Settings.properties, 'voice'));
record('Exact runtime and voice remain unselected pending tests', policy.initialProfile.speech.runtime === null && policy.initialProfile.speech.voiceId === null && policy.initialProfile.speech.voiceSelectionRequiresQualityTests === true);
record('Approved idempotency replay is twenty-four hours', policy.idempotency.replayWindowSeconds === 86400 && lifecycle.idempotencyContract.retentionSeconds === 86400 && policy.idempotency.replayCreatesJobOrReservation === false && policy.idempotency.idempotencyExpiryDeletesJobHistory === false && policy.idempotency.authOwnershipAndDeletionChecksAlwaysApply === true);
record('Route target belongs in request identity not uniqueness namespace', policy.idempotency.uniqueScope.length === 3 && !policy.idempotency.uniqueScope.some(item => /target/i.test(item)) && policy.idempotency.canonicalRequestIdentity.includes('concreteRouteTargetId'));
record('Approved initial demo capacity and quota values', policy.quota.dailySlotsPerUser === 3 && policy.quota.slotsPerNewAdmission === 1 && policy.quota.maxRunningJobsGlobal === 1 && policy.quota.maxWaitingJobsGlobal === 2 && policy.quota.maxActiveJobsPerProject === 1 && policy.quota.dailyBucketTimezone === 'UTC' && lifecycle.quotaContract.defaultDailySlotsPerUser === 3 && lifecycle.quotaContract.globalRunningLimit === 1 && lifecycle.quotaContract.globalWaitingLimit === 2);
record('Quota wire limit reports configuration while defaulting to three', spec.components.schemas.Usage.properties.dailyLimit.default === 3 && spec.components.schemas.Usage.properties.dailyLimit.minimum === 0 && !Object.hasOwn(spec.components.schemas.Usage.properties.dailyLimit, 'const'));
record('One slot reservation and durable render-start evidence', job.$defs.UsageReservation.properties.amount.const === 1 && job.$defs.UsageReservation.properties.unit.const === 'GENERATION_SLOT' && job.$defs.ExecutionState.required.includes('renderStartedAt') && policy.quota.renderStartedEvidenceSurvivesReclaim === true && policy.quota.automaticRecoveryCreatesExtraReservation === false);
record('Approved quota settlement distinguishes cancellation timing', policy.quota.settlement.completed === 'CONSUME' && policy.quota.settlement.systemOrProviderFailure === 'RELEASE' && policy.quota.settlement.userCancelledBeforeRenderStarted === 'RELEASE' && policy.quota.settlement.userCancelledAfterRenderStarted === 'CONSUME' && policy.quota.uncertainProcessStopFinalizesCancellationOrReleasesReservation === false);
record('Pipeline duration/validation failure releases its reservation', policy.quota.settlement.pipelineValidationOrDurationMismatch === 'RELEASE' && lifecycle.quotaContract.settlement.FAILED_PIPELINE_VALIDATION_OR_DURATION_MISMATCH === 'RELEASE');
record('Approved heartbeat lease and attempt test defaults', policy.worker.heartbeatSeconds === 10 && policy.worker.leaseSeconds === 60 && policy.worker.maxAutomaticExecutionAttemptsTotal === 2 && job.$defs.Generation.properties.attempt.maximum === 2 && job.$defs.ExecutionState.properties.attempt.maximum === 2);
record('Cancellation requires process stop and bounded recovery', policy.worker.cancelledRequiresConfirmedStop === true && policy.worker.staleWorkerMustStopOwnedProcesses === true && policy.worker.cancelCompleteRace === 'FIRST_COMMITTED_GUARDED_DATABASE_UPDATE_WINS');
record('Nonretryable revision failures cannot trigger same-snapshot fresh work', policy.worker.failedJobRetryRequiresRetryableError === true && policy.worker.revisionRequiredAllowsSameSnapshotRetry === false && policy.projectApproval.knownRevisionRequiredSnapshotAdmissible === false && /retryable=true/.test(lifecycle.recoveryAndRetry.retryAfterTerminalFailureOrCancellation.failureEligibilityGuard) && /GENERATION_NOT_RETRYABLE/.test(spec.paths['/generations/{generationId}/retry'].post.description));
record('Late cancellation evidence is evidence-only for pre-cancel work', policy.worker.lateRenderStartEvidenceMustPredateAcceptedCancellation === true && policy.worker.lateEvidenceMayLaunchOrResumeWork === false && lifecycle.transitions.some(item => item.event === 'CONFIRM_PRE_CANCEL_RENDER_START' && item.from === 'CANCEL_REQUESTED' && item.to === 'CANCEL_REQUESTED'));
const positiveLateEvidence = read(path.join(draftRoot, 'examples/jobs/late-pre-cancel-start-evidence.valid.json'));
const evidenceTimes = [positiveLateEvidence.lease.heartbeatAt, positiveLateEvidence.renderStartedAt, positiveLateEvidence.cancelRequestedAt, positiveLateEvidence.lease.expiresAt].map(value => Date.parse(value));
record('Positive late-evidence fixture has coherent pre-cancel timestamps and lease', evidenceTimes.every(Number.isFinite) && evidenceTimes[0] <= evidenceTimes[1] && evidenceTimes[1] < evidenceTimes[2] && evidenceTimes[2] < evidenceTimes[3] && (evidenceTimes[3] - evidenceTimes[0]) / 1000 === policy.worker.leaseSeconds);
record('No unbenchmarked stage timeout or duration SLA invented', policy.worker.stageTimeoutSeconds === null && sameSet(policy.worker.benchmarkedDurationPresetsSec, [30]));
record('Private local delivery with deferred remote redirects', policy.storage.initialProvider === 'PRIVATE_LOCAL_FILESYSTEM' && policy.storage.delivery === 'OWNER_AUTHENTICATED_STREAMING' && policy.storage.remote302Delivery === 'DEFERRED' && /deferred/i.test(spec.paths['/assets/{assetId}/download'].get.responses['302'].description));
record('Approved temporary and paired export retention', policy.storage.failedTemporaryArtifactMaxAgeSeconds === 86400 && policy.storage.exportRetentionSeconds === 604800 && policy.storage.videoAndCaptionShareExpiry === true && policy.storage.expiredAssetDownloadAllowed === false && lifecycle.retentionContract.failedTempRetentionSeconds === 86400 && lifecycle.retentionContract.pairedExportAvailabilitySeconds === 604800);
record('Expiration preserves historical job outcomes', policy.storage.historicalCompletedJobRetainsAssetReferences === true && policy.storage.deleteBlocksNewReadsImmediately === true && policy.storage.alreadyDeliveredBytesRetractable === false);
record('Private provenance separates inputs and publication', policy.provenance.approvedScriptAndSettingsImmutable === true && policy.provenance.crossEnvironmentIdenticalBytesGuaranteed === false && job.$defs.RenderManifest['x-internal'] === true && job.$defs.PublishedExportManifest['x-internal'] === true);
record('Approved password bounds are fifteen to one hundred twenty-eight', spec.components.schemas.SignupRequest.properties.password.minLength === 15 && spec.components.schemas.SignupRequest.properties.password.maxLength === 128 && policy.auth.passwordMinCharacters === 15 && policy.auth.passwordMaxCharacters === 128);
record('Approved access and refresh session lifetimes', policy.auth.accessLifetimeSeconds === 900 && policy.auth.refreshLifetimeSeconds === 604800 && policy.auth.refreshRotation === true && policy.auth.logoutRevokesRefreshAndClearsCookies === true);
record('Same-origin secure cookie CSRF policy without localStorage tokens', policy.auth.initialDeployment === 'SAME_ORIGIN_FRONTEND_AND_API' && policy.auth.productionHttpOnlyCookies === true && policy.auth.productionSecureCookies === true && policy.auth.explicitSameSiteRequired === true && policy.auth.csrfAndOriginChecksOnMutations === true && policy.auth.tokensInLocalStorage === false && policy.auth.privateResponseCacheControl === 'no-store');
record('Settings require reapproval while title-only edits preserve it', policy.projectApproval.generationSettingsChangeAfterApproval === 'NEW_DRAFT_REVIEW_AND_APPROVAL_REQUIRED' && policy.projectApproval.titleOnlyChangeRequiresReapproval === false && policy.projectApproval.combineNewSettingsWithOldApproval === false && policy.projectApproval.oldApprovedSnapshotAndSuccessfulExportsPreserved === true && policy.projectApproval.directPromptPatch === 'DEFERRED' && !Object.hasOwn(spec.components.schemas.ProjectPatch.properties, 'prompt'));
record('Lifecycle vocabulary agrees with shared job schema', sameSet(lifecycle.entitySeparation.generationStatus, job.$defs.GenerationStatus.enum) && JSON.stringify(lifecycle.stageOrder) === JSON.stringify(job.$defs.GenerationStage.enum));
for (const [route, pathItem] of Object.entries(spec.paths || {})) {
  record('No public worker route: ' + route, !route.includes('/worker'));
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!['get', 'post', 'patch', 'delete', 'put', 'head', 'options', 'trace'].includes(method)) continue;
    const label = method.toUpperCase() + ' ' + route;
    operations.push(label);
    record('Unique operationId: ' + label, Boolean(operation.operationId) && !operationIds.has(operation.operationId));
    operationIds.add(operation.operationId);
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])].map(parameter => dereference(parameter, specFile));
    for (const [, name] of route.matchAll(/\{([^}]+)\}/g)) record('Required path parameter: ' + label + ' ' + name, parameters.some(parameter => parameter.in === 'path' && parameter.name === name && parameter.required === true));
    if (['post', 'patch', 'delete', 'put'].includes(method)) {
      record('CSRF on mutation: ' + label, parameters.some(parameter => parameter.in === 'header' && parameter.name.toLowerCase() === 'x-csrf-token' && parameter.required === true));
      record('Origin policy on mutation: ' + label, parameters.some(parameter => parameter.in === 'header' && parameter.name.toLowerCase() === 'origin' && parameter.required === true));
    }
    if (label === 'POST /projects/{projectId}/generations' || label === 'POST /generations/{generationId}/retry') record('Idempotency header: ' + label, parameters.some(parameter => parameter.in === 'header' && parameter.name.toLowerCase() === 'idempotency-key' && parameter.required === true));
    record('Responses declared: ' + label, Object.keys(operation.responses || {}).length > 0);
    for (const [code, responseRef] of Object.entries(operation.responses || {})) {
      const response = dereference(responseRef, specFile);
      record('Response description: ' + label + ' ' + code, typeof response.description === 'string' && response.description.length > 0);
      record('Request ID header: ' + label + ' ' + code, Object.keys(response.headers || {}).some(name => name.toLowerCase() === 'x-request-id'));
      if (code === '204' || code === '302') record('Empty/binary exception has no JSON envelope: ' + label + ' ' + code, !response.content?.['application/json']);
    }
  }
}
record('Exactly the 32 approved operations', JSON.stringify(operations.sort()) === JSON.stringify(expectedOperations), {actual: operations.length, missing: expectedOperations.filter(value => !operations.includes(value)), extra: operations.filter(value => !expectedOperations.includes(value))});

const ajv = new Ajv({allErrors: true, strict: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false, allowUnionTypes: true});
addFormats(ajv);
ajv.addFormat('binary', true); // OpenAPI wire-format annotation; binary uploads are not JSON examples.
ajv.addFormat('int32', {type: 'number', validate: value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647});
ajv.addFormat('int64', {type: 'number', validate: Number.isInteger});
for (const file of [sceneFile, jobFile]) {
  const document = load(file);
  record('JSON Schema 2020-12 meta-validation: ' + path.basename(file), ajv.validateSchema(document), ajv.errors ? structuredClone(ajv.errors) : undefined);
}
for (const file of [sceneFile, jobFile, specFile]) ajv.addSchema(load(file), pathToFileURL(file).href);
for (const [name] of Object.entries(spec.components?.schemas || {})) schemaPointers.set(pathToFileURL(specFile).href + '#/components/schemas/' + pointerEscape(name), 'OpenAPI component ' + name);
for (const file of [sceneFile, jobFile]) for (const name of Object.keys(load(file).$defs || {})) schemaPointers.set(pathToFileURL(file).href + '#/$defs/' + pointerEscape(name), path.basename(file) + ' ' + name);
visit(spec, (value, pointer) => {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'schema') && pointer !== '') schemaPointers.set(pathToFileURL(specFile).href + '#' + pointer + '/schema', 'OpenAPI schema ' + pointer);
});
let compiledSchemas = 0;
for (const [uri, label] of schemaPointers) {
  try { if (!ajv.getSchema(uri)) throw new Error('Schema pointer unavailable'); compiledSchemas++; record('Schema compiles: ' + label, true); }
  catch (error) { record('Schema compiles: ' + label, false, error.message); }
}
for (const file of filesUnder(path.join(draftRoot, 'examples')).filter(file => path.basename(file) === 'cases.json')) {
  for (const item of read(file).cases || []) {
    const reference = new URL(item.schema, pathToFileURL(file)).href;
    const sampleFile = path.resolve(path.dirname(file), item.file);
    try {
      const validate = ajv.getSchema(reference);
      if (!validate) throw new Error('Example schema does not resolve');
      const actual = Boolean(validate(read(sampleFile)));
      const result = {name: item.name, file: path.relative(draftRoot, sampleFile), expectedValid: item.valid, actualValid: actual, passed: actual === item.valid};
      if (!result.passed) result.errors = validate.errors;
      examples.push(result);
      if (item.semanticViolations?.length) semanticExamples.push({name: item.name, violations: item.semanticViolations, note: 'Schema-only pass is expected; no application semantic validator is implemented.'});
    } catch (error) { examples.push({name: item.name, file: item.file, passed: false, error: error.message}); }
  }
}
// Validate inline JSON request/response examples against their declared schema.
visit(spec, (value, pointer) => {
  if (!value || typeof value !== 'object' || !value.schema) return;
  const samples = [];
  if (Object.hasOwn(value, 'example')) samples.push(['example', value.example]);
  for (const [name, example] of Object.entries(value.examples || {})) if (example && Object.hasOwn(example, 'value')) samples.push([name, example.value]);
  for (const [name, sample] of samples) {
    try {
      const validate = ajv.getSchema(pathToFileURL(specFile).href + '#' + pointer + '/schema');
      const passed = Boolean(validate?.(sample));
      examples.push({name: 'OpenAPI ' + pointer + ' ' + name, expectedValid: true, actualValid: passed, passed, ...(!passed ? {errors: validate?.errors} : {})});
    } catch (error) { examples.push({name: 'OpenAPI ' + pointer + ' ' + name, passed: false, error: error.message}); }
  }
});

const before = read(path.join(__dirname, 'preservation-before.json'));
const after = [];
function protectedFiles(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') protectedFiles(file); }
    else if (entry.isFile()) after.push({path: path.relative(repoRoot, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
}
protectedFiles(path.join(repoRoot, 'docs'));
protectedFiles(path.join(repoRoot, 'video-engine-poc'));
after.sort((a, b) => a.path.localeCompare(b.path));
const beforeMap = new Map(before.files.map(file => [file.path, file.sha256]));
const afterMap = new Map(after.map(file => [file.path, file.sha256]));
const changed = [...beforeMap].filter(([name, hash]) => afterMap.get(name) !== hash).map(([name]) => name);
const added = [...afterMap.keys()].filter(name => !beforeMap.has(name));
record('Approved docs and prototype unchanged', changed.length === 0 && added.length === 0, {protectedFileCount: before.files.length, changed, added});
fs.writeFileSync(path.join(__dirname, 'preservation-after.json'), JSON.stringify({scope: before.scope, files: after}, null, 2) + '\n');

const result = {
  status: checks.every(check => check.passed) && examples.every(example => example.passed) ? 'PASS' : 'FAIL',
  contractVersion: spec.info.version,
  decisionApprovalDate: policy.approvedOn,
  approvedDecisionCount: decisions.decisions.filter(item => item.status === 'APPROVED').length,
  implementationAuthorized: false,
  scope: 'Updated Phase 1 draft JSON, approved-policy consistency, local references, JSON Schema 2020-12, examples, selected OpenAPI structure, and preservation checks only. No API/worker/renderer implementation or runtime integration tests.',
  tools: {node: process.version, ajv: require(path.join(repoRoot, 'video-engine-poc/node_modules/schema-utils/node_modules/ajv/package.json')).version, dependenciesInstalled: false, strictSchemaMode: false, formatsAssertedWithAjvFormats: true},
  counts: {operations: operations.length, references: referenceCount, compiledSchemas, checks: checks.length, examples: examples.length, semanticOnlyExamples: semanticExamples.length},
  checks, examples, semanticOnlyExamples: semanticExamples,
  limitations: ['No dedicated full OpenAPI document validator is installed; selected structural checks are not a complete OAS conformance certification.', 'Schema-only checks do not establish ownership, unique scene IDs, cross-resource consistency, duration sums, quota accounting or state-transition correctness.', 'No features were enabled and no API handlers, database models, queues or rendering code were implemented.']
};
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({status: result.status, ...result.counts, failures: checks.filter(check => !check.passed).concat(examples.filter(example => !example.passed))}, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
