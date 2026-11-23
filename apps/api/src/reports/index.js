import {Router} from 'express';
import {sendData} from '../http.js';
import {createReportService} from './service.js';

export {createReportService} from './service.js';
export function buildReportRouter(options) {
  const router = Router(), service = createReportService(options);
  router.post('/reports', async (req, res) => {
    try {return sendData(req, res, await service.submit(req.auth.userId, req.body), 201);}
    catch (error) {
      if (error.code === 'REPORT_DAILY_LIMIT') res.set('Retry-After', String(Math.max(1, Math.ceil((new Date(error.details.resetAt).getTime() - Date.now()) / 1000))));
      throw error;
    }
  });
  return router;
}
