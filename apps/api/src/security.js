import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {hash, verify} from '@node-rs/argon2';
import {SignJWT, jwtVerify} from 'jose';
import {ApiError} from './http.js';

export const COOKIE_NAMES = Object.freeze({access: 'avs_access', refresh: 'avs_refresh', csrf: 'avs_csrf'});
export const cookieHash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export const randomSecret = () => randomBytes(32).toString('base64url');
export const equalSecret = (first, second) => typeof first === 'string' && typeof second === 'string' && Buffer.byteLength(first) === Buffer.byteLength(second) && timingSafeEqual(Buffer.from(first), Buffer.from(second));
const argonOptions = Object.freeze({algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32});
let passwordsInFlight = 0;
let dummyHashPromise;

async function withPasswordSlot(operation) {
  if (passwordsInFlight >= 2) throw new ApiError(429, 'AUTH_BUSY', 'Sign-in is busy. Please try again shortly.', {retryable: true});
  passwordsInFlight++;
  try { return await operation(); } finally { passwordsInFlight--; }
}

export const hashPassword = password => withPasswordSlot(() => hash(password, argonOptions));
export async function verifyPassword(passwordHash, password) {
  return withPasswordSlot(async () => {
    if (!dummyHashPromise) dummyHashPromise = hash(randomSecret(), argonOptions);
    const dummyHash = await dummyHashPromise;
    const hashToVerify = passwordHash || dummyHash;
    try { return await verify(hashToVerify, password); } catch { return false; }
  });
}

function cookieOptions(config, kind) {
  return {httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: kind === 'refresh' ? '/api/v1/auth' : '/api/v1'};
}

export function writeAuthCookies(res, config, {accessToken, refreshToken, expiresAt}, now = Date.now()) {
  res.cookie(COOKIE_NAMES.access, accessToken, {...cookieOptions(config, 'access'), maxAge: config.accessLifetimeSeconds * 1000});
  res.cookie(COOKIE_NAMES.refresh, refreshToken, {...cookieOptions(config, 'refresh'), maxAge: Math.max(0, new Date(expiresAt).getTime() - now)});
}

export function clearAuthCookies(res, config) {
  res.clearCookie(COOKIE_NAMES.access, cookieOptions(config, 'access'));
  res.clearCookie(COOKIE_NAMES.refresh, cookieOptions(config, 'refresh'));
}

const csrfSignature = (payload, config) => createHmac('sha256', config.csrfSecret).update('csrf-v1.' + payload).digest('base64url');
export function validCsrfToken(value, config, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 160) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{43}$/u.test(parts[0]) || !/^\d{13}$/u.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2])) return false;
  const issuedAt = Number(parts[1]);
  if (issuedAt > now || now - issuedAt >= config.csrfLifetimeSeconds * 1000) return false;
  return equalSecret(parts[2], csrfSignature(parts[0] + '.' + parts[1], config));
}

export function bootstrapCsrf(req, res, config, now = Date.now()) {
  const existing = req.cookies[COOKIE_NAMES.csrf];
  const token = validCsrfToken(existing, config, now) ? existing : (() => {
    const payload = randomSecret() + '.' + now;
    return payload + '.' + csrfSignature(payload, config);
  })();
  const issuedAt = Number(token.split('.')[1]);
  res.cookie(COOKIE_NAMES.csrf, token, {...cookieOptions(config, 'csrf'), maxAge: Math.max(0, issuedAt + config.csrfLifetimeSeconds * 1000 - now)});
  return token;
}

export function mutationGuard(config, now = Date.now) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.get('Origin') !== config.appOrigin || req.get('Sec-Fetch-Site') === 'cross-site') return next(new ApiError(403, 'ORIGIN_FORBIDDEN', 'This request must come from the application origin.'));
    const cookie = req.cookies[COOKIE_NAMES.csrf];
    const header = req.get('X-CSRF-Token');
    if (!validCsrfToken(cookie, config, now()) || !equalSecret(cookie, header)) return next(new ApiError(403, 'CSRF_INVALID', 'Refresh the page and try again.'));
    if (req.headers['content-length'] !== '0' && !req.is('application/json')) return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json for this request.'));
    return next();
  };
}

export async function signAccessToken(userId, sessionId, config, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({sid: String(sessionId)})
    .setProtectedHeader({alg: 'HS256', typ: 'JWT'})
    .setIssuer(config.jwtIssuer).setAudience(config.jwtAudience)
    .setSubject(String(userId)).setJti(randomUUID()).setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + config.accessLifetimeSeconds)
    .sign(new TextEncoder().encode(config.jwtSecret));
}

export async function verifyAccessToken(token, config, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  try {
    const {payload, protectedHeader} = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {algorithms: ['HS256'], issuer: config.jwtIssuer, audience: config.jwtAudience, currentDate: new Date(now), requiredClaims: ['exp', 'iat', 'sub', 'sid']});
    if (protectedHeader.typ !== 'JWT' || !/^[a-f0-9]{24}$/u.test(payload.sub) || !/^[a-f0-9]{24}$/u.test(payload.sid) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > Math.floor(now / 1000) || payload.exp - payload.iat !== config.accessLifetimeSeconds) return null;
    return {userId: payload.sub, sessionId: payload.sid};
  } catch { return null; }
}

export function parseRefreshToken(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  return parts.length === 2 && /^[a-f0-9]{24}$/u.test(parts[0]) && /^[A-Za-z0-9_-]{43}$/u.test(parts[1]) ? {sessionId: parts[0], tokenHash: cookieHash(value)} : null;
}
