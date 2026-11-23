import mongoose from 'mongoose';

const {Schema} = mongoose;
const ref = (name, options = {}) => ({type: Schema.Types.ObjectId, ref: name, ...options});
const mixed = Schema.Types.Mixed;
const active = ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED'];
const states = [...active, 'COMPLETED', 'FAILED', 'CANCELLED'];
const standard = {timestamps: true, versionKey: false, strict: 'throw'};
const settings = new Schema({mode: String, durationSec: Number, language: String, aspectRatio: String, tone: String, visualStyle: String, characterAssetId: {type: String, default: null}}, {_id: false, strict: 'throw'});
const nonnegative = {type: Number, min: 0, validate: Number.isSafeInteger};

export function createStudioModels(connection) {
  const schemas = {
    Project: new Schema({
      ownerId: ref('User', {required: true}), title: {type: String, required: true}, prompt: {type: String, required: true}, settings: {type: settings, required: true},
      phase: {type: String, enum: ['DRAFT', 'REVIEW', 'RENDERING', 'HAS_OUTPUT'], default: 'DRAFT'},
      currentStoryboardId: ref('Storyboard', {default: null}), activeGenerationId: ref('GenerationJob', {default: null}), latestGenerationId: ref('GenerationJob', {default: null}), latestOutputAssetId: ref('MediaAsset', {default: null}),
      version: {...nonnegative, default: 0}, planningToken: {type: String, default: null}, planningExpiresAt: {type: Date, default: null}, deletedAt: {type: Date, default: null}, cleanupScheduledAt: {type: Date, default: null},
      assistantConversationRevision: {...nonnegative, default: 0}, assistantLeaseToken: {type: String, default: null}, assistantLeaseExpiresAt: {type: Date, default: null},
      assistantCleanupCompletedAt: {type: Date, default: null},
      safetyHoldAt: {type: Date, default: null}, safetyHoldReason: {type: String, default: null}, safetyHoldReportId: ref('ContentReport', {default: null}), safetyRevision: {...nonnegative, default: 0},
    }, {...standard, collection: 'projects'}),
    Storyboard: new Schema({
      ownerId: ref('User', {required: true}), projectId: ref('Project', {required: true}), parentStoryboardId: ref('Storyboard', {default: null}),
      revision: {type: Number, required: true, min: 1, validate: Number.isSafeInteger}, status: {type: String, enum: ['DRAFT', 'APPROVED'], default: 'DRAFT'},
      schemaVersion: {type: Number, default: 1}, targetDurationSec: {type: Number, enum: [30, 60, 90], required: true}, settingsSnapshot: {type: settings, required: true}, scenes: {type: [mixed], required: true}, approvedAt: {type: Date, default: null}, contentHash: {type: String, default: null},
      sourceConversationRevision: {...nonnegative, default: 0}, sourceConversationHash: {type: String, default: null},
      sourceDurationGenerationId: ref('GenerationJob', {default: null}),
    }, {...standard, collection: 'storyboards'}),
    GenerationJob: new Schema({
      ownerId: ref('User', {required: true}), projectId: ref('Project', {required: true}), storyboardId: ref('Storyboard', {required: true}), approvedRevision: {type: Number, required: true},
      status: {type: String, enum: states, default: 'QUEUED'}, stage: {type: String, default: null}, progress: {type: mixed, default: () => ({completedStages: 0, totalStages: 6})}, attempt: {...nonnegative, default: 0},
      snapshot: {type: mixed, required: true}, storyboardHash: String, settingsHash: String, retryOf: ref('GenerationJob', {default: null}), reservationId: ref('Reservation'), bucketId: ref('UsageBucket'),
      lease: {type: mixed, default: null}, execution: {type: mixed, default: null}, renderStartedAt: {type: Date, default: null}, cancelRequestedAt: {type: Date, default: null}, cancelledAt: {type: Date, default: null}, completedAt: {type: Date, default: null}, failedAt: {type: Date, default: null},
      outputAssetId: ref('MediaAsset', {default: null}), captionAssetId: ref('MediaAsset', {default: null}), error: {type: mixed, default: null}, manifest: {type: mixed, default: null}, manifestPath: String, publishedManifestPath: String, deletedAt: {type: Date, default: null},
    }, {...standard, collection: 'generationJobs'}),
    UsageBucket: new Schema({userId: ref('User', {required: true}), periodStart: {type: Date, required: true}, limit: {...nonnegative, required: true}, reserved: {...nonnegative, default: 0}, consumed: {...nonnegative, default: 0}}, {...standard, collection: 'usageBuckets'}),
    Reservation: new Schema({ownerId: ref('User', {required: true}), generationId: ref('GenerationJob', {required: true}), bucketId: ref('UsageBucket', {required: true}), amount: {type: Number, enum: [1], default: 1}, unit: {type: String, default: 'GENERATION_SLOT'}, state: {type: String, enum: ['RESERVED', 'CONSUMED', 'RELEASED'], default: 'RESERVED'}}, {...standard, collection: 'generationReservations'}),
    AdmissionReceipt: new Schema({ownerId: ref('User', {required: true}), generationId: ref('GenerationJob'), action: {type: String, enum: ['START', 'RETRY'], required: true}, keyHash: {type: String, required: true}, identityHash: {type: String, required: true}, receipt: {type: mixed, required: true}, expiresAt: {type: Date, required: true}}, {...standard, collection: 'admissionReceipts'}),
    QueueState: new Schema({_id: String, activeCount: {...nonnegative, default: 0}, runningJobId: ref('GenerationJob', {default: null}), workerId: {type: String, default: null}, workerHeartbeatAt: {type: Date, default: null}, workerLeaseToken: {type: String, default: null}}, {...standard, collection: 'queueState'}),
    MediaAsset: new Schema({
      ownerId: ref('User', {required: true}), projectId: ref('Project', {required: true}), generationId: ref('GenerationJob', {required: true}), kind: {type: String, enum: ['VIDEO_EXPORT', 'CAPTION_TRACK'], required: true}, status: {type: String, enum: ['UPLOADING', 'READY', 'DELETING', 'DELETED', 'FAILED'], required: true}, mimeType: {type: String, enum: ['video/mp4', 'text/vtt'], required: true}, byteSize: {...nonnegative, required: true}, sha256: {type: String, required: true}, storage: {provider: {type: String, enum: ['LOCAL'], required: true}, key: {type: String, required: true}}, aiGenerated: {type: Boolean, default: true}, metadata: {type: mixed, default: {}}, expiresAt: {type: Date, required: true}, deletedAt: {type: Date, default: null},
    }, {...standard, collection: 'mediaAssets'}),
    AssistantMessage: new Schema({
      ownerId: ref('User', {required: true}), projectId: ref('Project', {required: true}),
      role: {type: String, enum: ['USER', 'ASSISTANT'], required: true}, content: {type: String, required: true},
      conversationRevision: {...nonnegative, required: true, min: 1}, suggestedSettings: {type: mixed, default: undefined}, missingInformation: {type: [String], default: undefined},
    }, {...standard, collection: 'assistantMessages'}),
    AssistantRequest: new Schema({
      ownerId: ref('User', {required: true}), projectId: ref('Project', {required: true}), keyHash: {type: String, required: true}, identityHash: {type: String, required: true},
      status: {type: String, enum: ['PROCESSING', 'COMPLETED', 'FAILED'], required: true}, leaseToken: {type: String, required: true}, leaseExpiresAt: {type: Date, required: true},
      expectedConversationRevision: {...nonnegative, required: true}, response: {type: mixed, default: null}, error: {type: mixed, default: null}, expiresAt: {type: Date, required: true},
    }, {...standard, collection: 'assistantRequests'}),
    AssistantUsageBucket: new Schema({
      ownerId: ref('User', {required: true}), periodStart: {type: Date, required: true}, count: {...nonnegative, required: true, default: 0},
    }, {...standard, collection: 'assistantUsageBuckets'}),
    ContentReport: new Schema({
      reporterId: ref('User', {required: true}), ownerId: ref('User', {default: null}), projectId: ref('Project', {default: null}), assetId: ref('MediaAsset', {default: null}),
      reasonCode: {type: String, enum: ['SAFETY', 'NON_CONSENSUAL', 'IMPERSONATION', 'PRIVACY', 'OTHER'], required: true}, description: {type: String, required: true, maxlength: 4000},
      status: {type: String, enum: ['OPEN', 'REVIEWED', 'RESOLVED'], default: 'OPEN'}, revision: {...nonnegative, default: 0}, resolvedAt: {type: Date, default: null},
    }, {...standard, collection: 'contentReports'}),
    ReportUsageBucket: new Schema({_id: String, reporterId: ref('User', {required: true}), periodStart: {type: Date, required: true}, count: {...nonnegative, default: 0}}, {...standard, collection: 'reportUsageBuckets'}),
    OperatorReviewAudit: new Schema({
      reportId: ref('ContentReport', {required: true}), operatorId: {type: String, required: true}, action: {type: String, enum: ['REVIEW', 'RESOLVE', 'HOLD', 'RELEASE'], required: true},
      reportRevision: {...nonnegative, required: true}, previousStatus: {type: String, required: true}, status: {type: String, required: true}, projectId: ref('Project', {default: null}), note: {type: String, required: true, maxlength: 1000},
    }, {timestamps: {createdAt: true, updatedAt: false}, versionKey: false, strict: 'throw', collection: 'operatorReviewAudit'}),
  };
  schemas.Project.index({ownerId: 1, deletedAt: 1, updatedAt: -1, _id: -1});
  schemas.Storyboard.index({ownerId: 1, projectId: 1, createdAt: -1});
  schemas.GenerationJob.index({projectId: 1}, {unique: true, partialFilterExpression: {status: {$in: active}}, name: 'one_active_generation_per_project'});
  schemas.GenerationJob.index({ownerId: 1, status: 1});
  schemas.GenerationJob.index({status: 1, 'lease.expiresAt': 1, createdAt: 1});
  schemas.UsageBucket.index({userId: 1, periodStart: 1}, {unique: true});
  schemas.Reservation.index({generationId: 1}, {unique: true});
  schemas.AdmissionReceipt.index({ownerId: 1, action: 1, keyHash: 1}, {unique: true});
  schemas.AdmissionReceipt.index({expiresAt: 1}, {expireAfterSeconds: 0});
  schemas.MediaAsset.index({generationId: 1, kind: 1}, {unique: true});
  schemas.MediaAsset.index({'storage.provider': 1, 'storage.key': 1}, {unique: true});
  schemas.MediaAsset.index({expiresAt: 1, status: 1});
  schemas.AssistantMessage.index({projectId: 1, conversationRevision: 1}, {unique: true});
  schemas.AssistantMessage.index({ownerId: 1, projectId: 1, conversationRevision: 1});
  schemas.AssistantRequest.index({ownerId: 1, keyHash: 1}, {unique: true});
  schemas.AssistantRequest.index({expiresAt: 1}, {expireAfterSeconds: 0});
  schemas.AssistantUsageBucket.index({ownerId: 1, periodStart: 1}, {unique: true});
  schemas.ContentReport.index({status: 1, createdAt: 1});
  schemas.ContentReport.index({reporterId: 1, createdAt: -1});
  schemas.OperatorReviewAudit.index({reportId: 1, reportRevision: 1}, {unique: true});
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, connection.models[name] || connection.model(name, schema)]));
}

export async function initializeStudioModels(models) {
  await Promise.all(Object.values(models).map(model => model.init()));
}
