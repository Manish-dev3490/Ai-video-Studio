import {ApiError} from '../http.js';
import {transaction} from '../jobs/service.js';
import {utcDay} from '../jobs/contracts.js';
import {assertNoConfiguredSecret, validateReport} from './validation.js';

export function createReportService({connection, models, config = {}, now = () => new Date()}) {
  return {
    async submit(reporterId, body) {
      const fields = validateReport(body);
      assertNoConfiguredSecret(fields.description, config);
      const time = now(), periodStart = utcDay(time);
      const bucketId = `${reporterId}:${periodStart.toISOString()}`;
      // Initialize outside admission's transaction: the stable _id serializes all
      // reports for this authenticated reporter, regardless of claimed target.
      try {await models.ReportUsageBucket.updateOne({_id: bucketId}, {$setOnInsert: {reporterId, periodStart, count: 0}}, {upsert: true});}
      catch (error) {if (error.code !== 11000) throw error;}
      return transaction(connection, async session => {
        const accepted = await models.ReportUsageBucket.updateOne({_id: bucketId, count: {$lt: config.reportDailyLimit ?? 10}}, {$inc: {count: 1}}).session(session);
        if (accepted.modifiedCount !== 1) throw new ApiError(429, 'REPORT_DAILY_LIMIT', 'Your daily report allowance is reached. Please try after the UTC daily reset.', {retryable: true, details: {resetAt: new Date(periodStart.getTime() + 86400000).toISOString()}});
        // Deliberately do not resolve a target here: private, missing and owned
        // identifiers have identical intake behavior and response fields.
        const [report] = await models.ContentReport.create([{reporterId, ...fields, status: 'OPEN', revision: 0, createdAt: time, updatedAt: time}], {session});
        return {id: String(report._id), status: 'OPEN', createdAt: time.toISOString()};
      });
    },
  };
}
