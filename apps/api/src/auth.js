import {randomBytes, randomUUID} from 'node:crypto';
import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {ApiError, sendData} from './http.js';
import {publicUser} from './repository.js';
import {COOKIE_NAMES, bootstrapCsrf, clearAuthCookies, cookieHash, equalSecret, hashPassword, parseRefreshToken, randomSecret, signAccessToken, verifyAccessToken, verifyPassword, writeAuthCookies} from './security.js';
import {validateCredentials, validateEmptyBody} from './validation.js';

const authRequired = () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
const isActiveUser = user => Boolean(user && user.status === 'ACTIVE');

export function createRequireAuth({config, repository, now = Date.now}) {
  return async (req, res, next) => {
    const claims = await verifyAccessToken(req.cookies[COOKIE_NAMES.access], config, now());
    if (!claims) return next(authRequired());
    const session = await repository.getActiveSession(claims.sessionId, now());
    if (!session || String(session.userId) !== claims.userId) return next(authRequired());
    const user = await repository.findUserById(claims.userId);
    if (!isActiveUser(user) || (session.authVersion ?? 0) !== (user.authVersion ?? 0)) return next(authRequired());
    req.auth = {...claims, authVersion: user.authVersion ?? 0};
    req.user = publicUser(user);
    return next();
  };
}

export function createAuthRouter({config, repository, now = Date.now, onSignup}) {
  const router = Router();
  const requireAuth = createRequireAuth({config, repository, now});
  const limiter = limit => rateLimit({windowMs: config.rateWindowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', {retryable: true}))});
  const credentialLimiter = limiter(config.authRateLimit);
  const refreshLimiter = limiter(config.refreshRateLimit);
  const bootstrapLimiter = limiter(120);

  async function revokeBrowserSession(req, time) {
    const previous = parseRefreshToken(req.cookies[COOKIE_NAMES.refresh]);
    if (previous) {
      const session = await repository.getSession(previous.sessionId);
      if (session && (equalSecret(session.tokenHash, previous.tokenHash) || session.usedTokenHashes.some(entry => equalSecret(entry, previous.tokenHash)))) await repository.revokeSession(previous.sessionId, time);
    }
    // A missing refresh cookie must not leave a still-valid access session
    // alive after logout/account replacement. Trust only verified JWT claims.
    const access = await verifyAccessToken(req.cookies[COOKIE_NAMES.access], config, time);
    if (access) {
      const session = await repository.getActiveSession(access.sessionId, time);
      if (session && String(session.userId) === access.userId) await repository.revokeSession(access.sessionId, time);
    }
  }

  async function issueSession(req, res, user) {
    const time = now();
    const id = randomBytes(12).toString('hex');
    const refreshToken = id + '.' + randomSecret();
    const expiresAt = new Date(time + config.refreshLifetimeSeconds * 1000);
    await repository.createSession({_id: id, userId: user._id, authVersion: user.authVersion ?? 0, familyId: randomUUID(), tokenHash: cookieHash(refreshToken), expiresAt, createdAt: new Date(time), lastUsedAt: new Date(time), rotatedAt: null, revokedAt: null, rotationCount: 0, usedTokenHashes: []});
    // Replacing a browser session also revokes its previous refresh family, but
    // only after the caller's opaque secret is recognized by that record.
    await revokeBrowserSession(req, time);
    const accessToken = await signAccessToken(user._id, id, config, time);
    writeAuthCookies(res, config, {accessToken, refreshToken, expiresAt}, time);
  }

  router.get('/csrf', bootstrapLimiter, (req, res, next) => {
    if ((req.get('Origin') && req.get('Origin') !== config.appOrigin) || req.get('Sec-Fetch-Site') === 'cross-site') return next(new ApiError(403, 'ORIGIN_FORBIDDEN', 'Open this page from the application origin.'));
    return sendData(req, res, {csrfToken: bootstrapCsrf(req, res, config, now())});
  });

  router.post('/signup', credentialLimiter, async (req, res) => {
    const {password, ...fields} = validateCredentials(req.body, true);
    const passwordHash = await hashPassword(password);
    let user;
    try { user = await repository.createUser({...fields, passwordHash, role: 'USER', status: 'ACTIVE'}); }
    catch (error) {
      if (error.code === 11000) throw new ApiError(409, 'EMAIL_UNAVAILABLE', 'An account could not be created with those details. Try signing in.');
      throw error;
    }
    await issueSession(req, res, user);
    if (onSignup) {try {await onSignup(user);} catch { /* Signup remains usable if email enqueueing is temporarily unavailable. */ }}
    return sendData(req, res, {user: publicUser(user)}, 201);
  });

  router.post('/login', credentialLimiter, async (req, res) => {
    const {emailNormalized, password} = validateCredentials(req.body);
    const user = await repository.findUserByEmail(emailNormalized);
    const passwordMatches = await verifyPassword(user?.passwordHash, password);
    if (!passwordMatches || !isActiveUser(user)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    await issueSession(req, res, user);
    return sendData(req, res, {user: publicUser(user)});
  });

  router.post('/refresh', refreshLimiter, async (req, res) => {
    validateEmptyBody(req.body);
    const token = parseRefreshToken(req.cookies[COOKIE_NAMES.refresh]);
    if (!token) { clearAuthCookies(res, config); throw authRequired(); }
    const session = await repository.getSession(token.sessionId);
    const time = now();
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= time) { clearAuthCookies(res, config); throw authRequired(); }
    if (!equalSecret(session.tokenHash, token.tokenHash)) {
      await repository.revokeIfUsedToken(token.sessionId, token.tokenHash, time);
      clearAuthCookies(res, config);
      throw authRequired();
    }
    if (session.rotationCount >= config.maxSessionRotations) {
      await repository.revokeSession(token.sessionId, time);
      clearAuthCookies(res, config);
      throw authRequired();
    }
    const user = await repository.findUserById(session.userId);
    if (!isActiveUser(user) || (session.authVersion ?? 0) !== (user.authVersion ?? 0)) {
      await repository.revokeSession(token.sessionId, time);
      clearAuthCookies(res, config);
      throw authRequired();
    }
    const refreshToken = token.sessionId + '.' + randomSecret();
    const rotated = await repository.rotateSession(token.sessionId, token.tokenHash, cookieHash(refreshToken), time, config.maxSessionRotations);
    if (!rotated) {
      // A CAS loser is a confirmed replay only if the previous hash is now in
      // this same document. The update cannot create a family after revocation.
      await repository.revokeIfUsedToken(token.sessionId, token.tokenHash, time);
      clearAuthCookies(res, config);
      throw authRequired();
    }
    const accessToken = await signAccessToken(user._id, token.sessionId, config, time);
    writeAuthCookies(res, config, {accessToken, refreshToken, expiresAt: rotated.expiresAt}, time);
    return sendData(req, res, {user: publicUser(user)});
  });

  router.post('/logout', async (req, res) => {
    validateEmptyBody(req.body);
    await revokeBrowserSession(req, now());
    clearAuthCookies(res, config);
    return res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => sendData(req, res, {user: req.user}));
  return router;
}
