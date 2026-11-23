import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {setTimeout as pause} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {createRequireAuth} from '../auth.js';
import {ApiError, sendData} from '../http.js';
import {clearAuthCookies} from '../security.js';
import {validateEmptyBody} from '../validation.js';
import {createAccountModels, initializeAccountModels} from './models.js';
import {createAccountServices, emailDelivery} from './service.js';
import {actionToken, displayName, email, password, strictObject} from './validation.js';

export {createAccountModels, initializeAccountModels} from './models.js';
export {createAccountServices, actionTokenHash, authEpoch, epochFilter, emailDelivery} from './service.js';

export function createAccountSubsystem({connection, repository, config, now = Date.now, encryptMail}) {
  const models = {...repository.models, ...createAccountModels(connection)};
  const service = createAccountServices({connection, models, config, now, encryptMail});
  const authRouter = Router();
  const accountRouter = Router();
  const requireAuth = createRequireAuth({config, repository, now});
  const limiter = limit => rateLimit({windowMs: config.rateWindowMs ?? 900000, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', {retryable: true}))});
  const requests = limiter(config.accountActionRateLimit ?? 10);
  const confirmations = limiter(config.accountTokenRateLimit ?? 30);
  const profileWrites = limiter(config.accountProfileRateLimit ?? 30);

  accountRouter.use(requireAuth);
  accountRouter.get('/profile', async (req, res) => sendData(req, res, await service.profile(req.auth.userId, req.auth.authVersion)));
  accountRouter.patch('/profile', profileWrites, async (req, res) => {
    strictObject(req.body, ['displayName']);
    return sendData(req, res, await service.updateProfile(req.auth.userId, req.auth.authVersion, displayName(req.body.displayName)));
  });
  accountRouter.post('/email-change', requests, async (req, res) => {
    strictObject(req.body, ['email', 'currentPassword']);
    await service.requestEmailChange(req.auth.userId, req.auth.authVersion, email(req.body.email), password(req.body.currentPassword, {current: true}));
    return sendData(req, res, {status: 'ACCEPTED'}, 202);
  });
  accountRouter.delete('/email-change', profileWrites, async (req, res) => {
    validateEmptyBody(req.body);
    await service.cancelEmailChange(req.auth.userId, req.auth.authVersion);
    return res.status(204).end();
  });

  authRouter.post('/request-email-verification', requireAuth, requests, async (req, res) => {
    validateEmptyBody(req.body);
    await service.requestVerification(req.auth.userId, req.auth.authVersion);
    return sendData(req, res, {status: 'ACCEPTED'}, 202);
  });
  authRouter.post('/forgot-password', requests, async (req, res) => {
    const started = performance.now();
    let failure;
    try {
      strictObject(req.body, ['email']);
      await service.forgotPassword(email(req.body.email));
    } catch (error) {failure = error;}
    const wait = Math.max(0, (config.recoveryResponseFloorMs ?? 250) - (performance.now() - started));
    if (wait) await pause(wait);
    if (failure) throw failure;
    return sendData(req, res, {status: 'ACCEPTED', emailDelivery: emailDelivery(config)}, 202);
  });
  authRouter.post('/verify-email', confirmations, async (req, res) => {
    strictObject(req.body, ['token']); actionToken(req.body.token);
    await service.verifyEmail(req.body.token);
    return sendData(req, res, {status: 'VERIFIED'});
  });
  authRouter.post('/reset-password', confirmations, async (req, res) => {
    strictObject(req.body, ['token', 'password']); actionToken(req.body.token);
    await service.resetPassword(req.body.token, password(req.body.password));
    clearAuthCookies(res, config);
    return sendData(req, res, {status: 'PASSWORD_RESET'});
  });
  authRouter.post('/confirm-email-change', confirmations, async (req, res) => {
    strictObject(req.body, ['token']); actionToken(req.body.token);
    await service.confirmEmailChange(req.body.token);
    clearAuthCookies(res, config);
    return sendData(req, res, {status: 'EMAIL_CHANGED'});
  });
  return {authRouter, accountRouter, models, service, initialize: () => initializeAccountModels(models), onSignup: async user => {
    if (config.mailMode && config.mailMode !== 'disabled') await service.requestVerification(user._id, user.authVersion ?? 0);
  }};
}
