import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import {createAuthRouter, createRequireAuth} from './auth.js';
import {ApiError, errorHandler, sendData} from './http.js';
import {mutationGuard} from './security.js';
import {createAccountSubsystem} from './account/index.js';
import {encryptMail} from './mail.js';
import {requestMetadataLogger, requireHttps} from './production-runtime.js';

export function createApp({config, repository, dashboardRouter, studioRouter, accountSubsystem, staticDirectory, readinessCheck, requestLogSink, now = Date.now}) {
  const app = express();
  const account = accountSubsystem ?? (repository.models?.User?.db ? createAccountSubsystem({connection: repository.models.User.db, repository, config, now, encryptMail}) : null);
  app.locals.account = account;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'loopback' ? 'loopback' : false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(requestMetadataLogger({enabled: config.requestLogging === true, ...(requestLogSink ? {write: requestLogSink} : {})}));
  app.use(helmet({referrerPolicy: {policy: 'no-referrer'}, contentSecurityPolicy: {directives: {defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], fontSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: config.isProduction ? [] : null}}, strictTransportSecurity: config.isProduction ? undefined : false}));
  app.use(requireHttps(config));
  app.get('/api/v1/health', (req, res) => sendData(req, res, {status: 'ok'}));
  app.get('/api/v1/ready', async (req, res) => {
    let ready = false;
    try {ready = typeof readinessCheck === 'function' && await readinessCheck() === true;} catch { /* No database detail is public. */ }
    return sendData(req, res, {status: ready ? 'ready' : 'not_ready'}, ready ? 200 : 503);
  });
  app.use('/api/v1', cookieParser(), mutationGuard(config, now));
  app.use('/api/v1/auth', express.json({limit: '16kb', strict: true}), createAuthRouter({config, repository, now, onSignup: account?.onSignup}), ...(account ? [account.authRouter] : []));
  if (account) app.use('/api/v1/account', express.json({limit: '16kb', strict: true}), account.accountRouter);
  app.use('/api/v1', express.json({limit: '256kb', strict: true}));
  if (studioRouter || dashboardRouter) app.use('/api/v1', createRequireAuth({config, repository, now}), ...[studioRouter, dashboardRouter].filter(Boolean));
  app.use('/api', (req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'This endpoint is not available.')));
  if (staticDirectory && fs.existsSync(path.join(staticDirectory, 'index.html'))) {
    app.use(express.static(staticDirectory, {index: false, dotfiles: 'deny', fallthrough: true}));
    app.get('/{*path}', (req, res, next) => {
      if (path.extname(req.path)) return next();
      return res.sendFile(path.join(staticDirectory, 'index.html'));
    });
  }
  app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'This page is not available.')));
  app.use(errorHandler);
  return app;
}
