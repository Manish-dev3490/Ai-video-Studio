import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ApiError, sendData} from '../http.js';
import {createAssistantServices} from './service.js';

export {createAssistantServices, readAssistantContext, cleanupAssistantHistory} from './service.js';
export {validateAssistantRequest, historyQuery, publicAssistantMessage} from './validation.js';

export function buildAssistantRouter(options) {
  const router = Router();
  const service = createAssistantServices(options);
  const limiter = rateLimit({windowMs: 15 * 60 * 1000, limit: options.config.assistantRateLimit ?? 10, keyGenerator: req => req.auth.userId, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many assistant requests. Please wait before trying again.', {retryable: true, details: {requestAccepted: false}}))});
  router.post('/assistant/messages', limiter, async (req, res) => {
    const replay = req.get('X-Assistant-Replay-Only');
    if (replay !== undefined && replay !== 'true') throw new ApiError(422, 'VALIDATION_FAILED', 'Use a valid assistant replay mode.');
    if (replay === 'true' && !req.get('Idempotency-Key')) throw new ApiError(422, 'VALIDATION_FAILED', 'Checking a saved reply requires its original request key.');
    const controller = new AbortController();
    const disconnected = () => {if (!res.writableEnded) controller.abort();};
    res.once('close', disconnected);
    try {return sendData(req, res, await service.send(req.auth.userId, req.body, {idempotencyKey: req.get('Idempotency-Key'), replayOnly: replay === 'true', signal: controller.signal}));}
    catch (error) {
      if (error.code === 'AI_QUOTA_EXCEEDED' && error.details?.resetAt) res.set('Retry-After', String(Math.max(1, Math.ceil((new Date(error.details.resetAt).getTime() - Date.now()) / 1000))));
      else if (['ASSISTANT_IN_PROGRESS', 'ASSISTANT_REQUEST_IN_PROGRESS'].includes(error.code)) res.set('Retry-After', '3');
      throw error;
    } finally {res.off('close', disconnected);}
  });
  router.get('/projects/:projectId/assistant/messages', async (req, res) => sendData(req, res, await service.history(req.auth.userId, req.params.projectId, req.query)));
  return router;
}
