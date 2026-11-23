import {ApiError} from '../http.js';
import {createGenerationService, transaction} from '../jobs/service.js';
import {assertNoConfiguredSecret, displayOperatorText, privateText, reportId} from './validation.js';

const notFound = () => new ApiError(404, 'REPORT_NOT_FOUND', 'This report is not available.');
const metadata = report => ({id: String(report._id), reasonCode: report.reasonCode, status: report.status, revision: report.revision, createdAt: new Date(report.createdAt).toISOString(), resolvedAt: report.resolvedAt ? new Date(report.resolvedAt).toISOString() : null});
const conflict = message => new ApiError(409, 'REVIEW_CONFLICT', message);

/** Local trusted-process capability only. Never mount this service on HTTP. */
export function createOperatorReviewService({connection, models, config = {}, now = () => new Date()}) {
  const generations = createGenerationService({connection, models, config, now});
  async function resolveProject(report, session) {
    // Resolve the supplied identifier at review time. Never trust reporter-set
    // ownership, and never follow an asset's mismatched owner/project link.
    let project;
    if (report.projectId) project = await models.Project.findById(report.projectId).session(session).lean();
    else if (report.assetId) {
      const asset = await models.MediaAsset.findById(report.assetId).session(session).lean();
      if (asset) project = await models.Project.findOne({_id: asset.projectId, ownerId: asset.ownerId}).session(session).lean();
    }
    return project || null;
  }
  return {
    async list({status = 'OPEN', limit = 20} = {}) {
      if (!['OPEN', 'REVIEWED', 'RESOLVED'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a report status and a limit from 1 to 50.');
      return (await models.ContentReport.find({status}).sort({createdAt: 1, _id: 1}).limit(limit).lean()).map(metadata);
    },
    async show(id) {
      const report = await models.ContentReport.findById(reportId(id)).lean();
      if (!report) throw notFound();
      const audit = await models.OperatorReviewAudit.find({reportId: report._id}).sort({reportRevision: -1}).limit(20).lean();
      return {...metadata(report), target: report.projectId ? {projectId: String(report.projectId)} : {assetId: String(report.assetId)}, description: displayOperatorText(report.description, config), audit: audit.map(entry => ({action: entry.action, operatorId: displayOperatorText(entry.operatorId, config), reportRevision: entry.reportRevision, previousStatus: entry.previousStatus, status: entry.status, note: displayOperatorText(entry.note, config), createdAt: new Date(entry.createdAt).toISOString()}))};
    },
    async act({id, action, expectedRevision, operatorId, note}) {
      reportId(id);
      if (!['REVIEW', 'RESOLVE', 'HOLD', 'RELEASE'].includes(action) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof operatorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{1,79}$/u.test(operatorId)) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a supported action, current report revision and operator identifier.');
      note = privateText(note, 500); assertNoConfiguredSecret(note, config); assertNoConfiguredSecret(operatorId, config);
      return transaction(connection, async session => {
        const report = await models.ContentReport.findById(id).session(session).lean();
        if (!report) throw notFound();
        if (report.revision !== expectedRevision) throw conflict('The report changed. Read its current revision before acting.');
        if (action === 'REVIEW' && report.status !== 'OPEN') throw conflict('Only an open report can move to reviewed.');
        if (action === 'RESOLVE' && report.status !== 'REVIEWED') throw conflict('Review this report before resolving it.');
        if (action === 'HOLD' && report.status === 'RESOLVED') throw conflict('A resolved report cannot introduce a new hold.');
        const time = now();
        const project = ['HOLD', 'RELEASE'].includes(action) ? await resolveProject(report, session) : null;
        if (['HOLD', 'RELEASE'].includes(action) && !project) throw conflict('The claimed target has no verified project. No enforcement was applied.');
        if (action === 'HOLD') {
          if (project.safetyHoldAt) throw conflict('This project already has a safety hold. Inspect the existing case first.');
          const changed = await models.Project.updateOne({_id: project._id, safetyHoldAt: null}, {$set: {safetyHoldAt: time, safetyHoldReason: report.reasonCode, safetyHoldReportId: report._id, planningToken: null, planningExpiresAt: null, assistantLeaseToken: null, assistantLeaseExpiresAt: null}, $inc: {version: 1, safetyRevision: 1}}).session(session);
          if (changed.modifiedCount !== 1) throw conflict('The project hold changed. Review its state again.');
          const jobs = await models.GenerationJob.find({projectId: project._id, ownerId: project.ownerId, status: {$in: ['QUEUED', 'PROCESSING', 'CANCEL_REQUESTED']}}).session(session).lean();
          for (const job of jobs) {
            if (job.status === 'QUEUED' && !job.lease) await generations.settle(job, 'CANCELLED', session);
            else await models.GenerationJob.updateOne({_id: job._id, status: {$in: ['QUEUED', 'PROCESSING']}}, {$set: {status: 'CANCEL_REQUESTED', cancelRequestedAt: time}}).session(session);
          }
        } else if (action === 'RELEASE') {
          if (!project.safetyHoldAt || String(project.safetyHoldReportId) !== String(report._id)) throw conflict('Only the case that owns the active hold can release it.');
          const changed = await models.Project.updateOne({_id: project._id, safetyHoldReportId: report._id, safetyHoldAt: {$ne: null}}, {$set: {safetyHoldAt: null, safetyHoldReason: null, safetyHoldReportId: null}, $inc: {version: 1, safetyRevision: 1}}).session(session);
          if (changed.modifiedCount !== 1) throw conflict('The project hold changed. Review its state again.');
        }
        const status = action === 'RESOLVE' ? 'RESOLVED' : report.status === 'OPEN' ? 'REVIEWED' : report.status;
        const update = {$set: {status, ...(action === 'RESOLVE' ? {resolvedAt: time} : {}), ...(project ? {ownerId: project.ownerId} : {})}, $inc: {revision: 1}};
        const saved = await models.ContentReport.findOneAndUpdate({_id: report._id, revision: expectedRevision}, update, {returnDocument: 'after', session}).lean();
        if (!saved) throw conflict('The report changed. Read its current revision before acting.');
        await models.OperatorReviewAudit.create([{reportId: report._id, operatorId, action, reportRevision: saved.revision, previousStatus: report.status, status, projectId: project?._id ?? null, note, createdAt: time}], {session});
        return {...metadata(saved), action, projectHold: action === 'HOLD' ? 'HELD' : action === 'RELEASE' ? 'RELEASED' : undefined};
      });
    },
  };
}
