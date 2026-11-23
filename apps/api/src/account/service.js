import mongoose from 'mongoose';
import {createHmac} from 'node:crypto';
import {ApiError} from '../http.js';
import {publicUser} from '../repository.js';
import {hashPassword, randomSecret, verifyPassword} from '../security.js';
import {actionToken, invalidLink} from './validation.js';

export const authEpoch = value => value?.authVersion ?? 0;
export const epochFilter = version => version === 0 ? {$or: [{authVersion: 0}, {authVersion: {$exists: false}}]} : {authVersion: version};
export const actionTokenHash = (token, purpose, config) => createHmac('sha256', config.jwtSecret).update('account-action-v1.' + purpose + '.' + token).digest('hex');
const signedOut = () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
const identifier = value => String(value);
const iso = value => value ? new Date(value).toISOString() : null;
const unsettled = ['QUEUED', 'SENDING'];

export function emailDelivery(config) {
  if (config.mailMode === 'local') return {mode: 'LOCAL_PREVIEW', available: true};
  if (['smtp', 'resend'].includes(config.mailMode)) return {mode: 'EMAIL', available: true};
  return {mode: 'UNAVAILABLE', available: false};
}

export function createAccountServices({connection, models, config, now = Date.now, encryptMail}) {
  const {User, Session, ActionToken, MailOutbox} = models;
  const transaction = operation => connection.transaction(operation, {readConcern: {level: 'snapshot'}, writeConcern: {w: 'majority'}});
  const activeUserFilter = (id, version) => ({_id: id, status: 'ACTIVE', ...(version === undefined ? {} : epochFilter(version))});
  const assertAvailable = () => {
    if (!emailDelivery(config).available || typeof encryptMail !== 'function') throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'Email delivery is not configured. Please try again after the studio operator connects email.', {retryable: true});
  };

  async function enqueue(session, {user, purpose, action = null, to, subject, text, expiresAt}) {
    const context = {userId: identifier(user._id), purpose, actionId: action ? identifier(action._id) : null, tokenHash: action?.tokenHash ?? null, authVersion: authEpoch(user)};
    const payload = await encryptMail({to, subject, text}, config, context);
    await MailOutbox.create([{...context, payload, expiresAt, nextAttemptAt: new Date(now()), status: 'QUEUED', attempts: 0, leaseUntil: null, deliveryToken: null}], {session, ordered: true});
  }

  async function profile(userId, version) {
    const user = await User.findOne(activeUserFilter(userId, version)).lean();
    if (!user) throw signedOut();
    const pending = await ActionToken.findOne({userId: user._id, purpose: 'CHANGE_EMAIL', emailNormalized: user.emailNormalized, authVersion: authEpoch(user), usedAt: null, expiresAt: {$gt: new Date(now())}}).lean();
    return {user: publicUser(user), emailVerified: Boolean(user.emailVerifiedAt), emailVerifiedAt: iso(user.emailVerifiedAt), pendingEmailChange: pending ? {email: pending.targetEmailNormalized, expiresAt: iso(pending.expiresAt)} : null, emailDelivery: emailDelivery(config)};
  }

  async function updateProfile(userId, version, name) {
    const user = await User.findOneAndUpdate(activeUserFilter(userId, version), {$set: {displayName: name}}, {returnDocument: 'after', runValidators: true}).lean();
    if (!user) throw signedOut();
    return profile(userId, version);
  }

  async function requestAction(userId, purpose, {expectedVersion, expectedEmail, targetEmailNormalized} = {}) {
    assertAvailable();
    try {return await transaction(async session => {
      const time = now();
      const user = await User.findOne({...activeUserFilter(userId, expectedVersion), ...(expectedEmail ? {emailNormalized: expectedEmail} : {})}).session(session).lean();
      if (!user) return {state: 'INELIGIBLE'};
      if (purpose === 'VERIFY_EMAIL' && user.emailVerifiedAt) return {state: 'INELIGIBLE'};
      if (purpose === 'CHANGE_EMAIL') {
        if (targetEmailNormalized === user.emailNormalized) throw new ApiError(422, 'EMAIL_UNCHANGED', 'Choose a different email address.');
        if (await User.exists({emailNormalized: targetEmailNormalized}).session(session)) return {state: 'INELIGIBLE'};
      }
      const previous = await ActionToken.findOne({userId: user._id, purpose}).session(session).lean();
      const cooldownMs = (config.actionResendSeconds ?? 60) * 1000;
      if (previous && new Date(previous.issuedAt).getTime() > time - cooldownMs) return {state: 'COOLDOWN'};
      const actionId = previous?._id ?? new mongoose.Types.ObjectId();
      const token = identifier(actionId) + '.' + randomSecret();
      const tokenHash = actionTokenHash(token, purpose, config);
      const lifetimeSeconds = purpose === 'VERIFY_EMAIL' ? config.verifyEmailLifetimeSeconds ?? 86400 : config.recoveryLifetimeSeconds ?? 1800;
      const action = {_id: actionId, userId: user._id, purpose, emailNormalized: user.emailNormalized, targetEmailNormalized: targetEmailNormalized ?? null, authVersion: authEpoch(user), tokenHash, issuedAt: new Date(time), expiresAt: new Date(time + lifetimeSeconds * 1000), usedAt: null};
      if (previous) await ActionToken.replaceOne({_id: previous._id}, action, {session, runValidators: true});
      else await ActionToken.create([action], {session, ordered: true});
      await MailOutbox.updateMany({userId: user._id, purpose, status: {$in: unsettled}}, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null}, $unset: {payload: 1}}).session(session);
      const path = {VERIFY_EMAIL: '/verify-email', RESET_PASSWORD: '/reset-password', CHANGE_EMAIL: '/confirm-email-change'}[purpose];
      const url = new URL(path, config.appOrigin);
      url.hash = 'token=' + token;
      const subject = {VERIFY_EMAIL: 'Verify your AI Video Studio email', RESET_PASSWORD: 'Reset your AI Video Studio password', CHANGE_EMAIL: 'Confirm your AI Video Studio email change'}[purpose];
      const instruction = {VERIFY_EMAIL: 'Confirm that this email address belongs to you.', RESET_PASSWORD: 'Choose a new password for your AI Video Studio account.', CHANGE_EMAIL: 'Confirm this new sign-in email address. Your current address stays active until you confirm.'}[purpose];
      const text = `${instruction}\n\nOpen this link and confirm the action:\n${url.href}\n\nThis link expires in ${purpose === 'VERIFY_EMAIL' ? '24 hours' : '30 minutes'} and works once. If you did not request this, ignore this email. Only the latest requested link works.`;
      await enqueue(session, {user, purpose, action, to: targetEmailNormalized ?? user.emailNormalized, subject, text, expiresAt: action.expiresAt});
      return {state: 'QUEUED'};
    });} catch (error) {
      // Two first-time requests can race the unique user/purpose index. A
      // duplicate winner is equivalent to the durable resend cooldown, never
      // an account-dependent recovery error or a second email.
      if (error.code === 11000) return {state: 'COOLDOWN'};
      throw error;
    }
  }

  async function forgotPassword(normalizedEmail) {
    assertAvailable();
    const user = await User.findOne({emailNormalized: normalizedEmail, status: 'ACTIVE'}).lean();
    if (user) {
      try {await requestAction(user._id, 'RESET_PASSWORD', {expectedVersion: authEpoch(user), expectedEmail: user.emailNormalized});}
      catch {
        // An account-dependent queue/encryption failure must not reveal whether
        // this address exists. The transaction rolls back; a future request can
        // try again, and any previously issued link remains unchanged.
      }
    }
  }

  async function requestVerification(userId, version) {
    return requestAction(userId, 'VERIFY_EMAIL', {expectedVersion: version});
  }

  async function requestEmailChange(userId, version, target, currentPassword) {
    assertAvailable();
    const user = await User.findOne(activeUserFilter(userId, version)).select('+passwordHash').lean();
    if (!user) throw signedOut();
    if (!await verifyPassword(user.passwordHash, currentPassword)) throw new ApiError(403, 'CURRENT_PASSWORD_INCORRECT', 'Your current password is incorrect.');
    const result = await requestAction(user._id, 'CHANGE_EMAIL', {expectedVersion: authEpoch(user), expectedEmail: user.emailNormalized, targetEmailNormalized: target});
    if (result.state === 'INELIGIBLE') {
      const current = await User.findOne(activeUserFilter(userId, version)).lean();
      if (!current) throw signedOut();
    }
  }

  async function cancelEmailChange(userId, version) {
    await transaction(async session => {
      if (!await User.exists(activeUserFilter(userId, version)).session(session)) throw signedOut();
      const time = new Date(now());
      await ActionToken.updateMany({userId, purpose: 'CHANGE_EMAIL', authVersion: version, usedAt: null}, {$set: {usedAt: time}}).session(session);
      await MailOutbox.updateMany({userId, purpose: 'CHANGE_EMAIL', status: {$in: unsettled}}, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null}, $unset: {payload: 1}}).session(session);
    });
  }

  async function tokenRecord(value, purpose, session) {
    const parsed = actionToken(value);
    let query = ActionToken.findOne({_id: parsed.id, purpose, tokenHash: actionTokenHash(parsed.token, purpose, config), usedAt: null, expiresAt: {$gt: new Date(now())}});
    if (session) query = query.session(session);
    const record = await query.lean();
    if (!record) throw invalidLink();
    let userQuery = User.findOne({...activeUserFilter(record.userId, record.authVersion), emailNormalized: record.emailNormalized});
    if (session) userQuery = userQuery.session(session);
    const user = await userQuery.lean();
    if (!user) throw invalidLink();
    return {record, user};
  }

  async function complete(value, purpose, {passwordHash} = {}) {
    try {
      return await transaction(async session => {
        const {record, user} = await tokenRecord(value, purpose, session);
        const time = new Date(now());
        const sensitive = purpose !== 'VERIFY_EMAIL';
        const update = purpose === 'VERIFY_EMAIL' ? {$set: {emailVerifiedAt: time}} : purpose === 'RESET_PASSWORD' ? {$set: {passwordHash}, $inc: {authVersion: 1}} : {$set: {emailNormalized: record.targetEmailNormalized, emailVerifiedAt: time}, $inc: {authVersion: 1}};
        if (sensitive && authEpoch(user) >= Number.MAX_SAFE_INTEGER) throw invalidLink();
        const updated = await User.findOneAndUpdate({...activeUserFilter(user._id, record.authVersion), emailNormalized: record.emailNormalized}, update, {session, returnDocument: 'after', runValidators: true}).lean();
        if (!updated) throw invalidLink();
        const used = await ActionToken.updateOne({_id: record._id, tokenHash: record.tokenHash, usedAt: null}, {$set: {usedAt: time}}).session(session);
        if (used.modifiedCount !== 1) throw invalidLink();
        if (sensitive) {
          await ActionToken.updateMany({userId: user._id, usedAt: null}, {$set: {usedAt: time}}).session(session);
          await Session.updateMany({userId: user._id, revokedAt: null}, {$set: {revokedAt: time}}).session(session);
          await MailOutbox.updateMany({userId: user._id, purpose: {$ne: 'SECURITY_NOTICE'}, status: {$in: unsettled}}, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null}, $unset: {payload: 1}}).session(session);
          // This notification contains no action link or credential. Queue it in
          // the same transaction so successful security changes remain durable.
          await enqueue(session, {user: updated, purpose: 'SECURITY_NOTICE', to: user.emailNormalized, subject: purpose === 'RESET_PASSWORD' ? 'Your AI Video Studio password was reset' : 'Your AI Video Studio email was changed', text: purpose === 'RESET_PASSWORD' ? 'Your AI Video Studio password was reset. All existing sign-in sessions have ended. If you did not request this, contact the studio operator.' : 'Your AI Video Studio sign-in email was changed. All existing sign-in sessions have ended. If you did not request this, contact the studio operator.', expiresAt: new Date(now() + 86400000)});
        } else {
          await MailOutbox.updateMany({actionId: record._id, tokenHash: record.tokenHash, status: {$in: unsettled}}, {$set: {status: 'CANCELLED', leaseUntil: null, deliveryToken: null}, $unset: {payload: 1}}).session(session);
        }
        return {userId: identifier(user._id)};
      });
    } catch (error) {
      if (error.code === 11000 && purpose === 'CHANGE_EMAIL') throw new ApiError(422, 'EMAIL_CHANGE_UNAVAILABLE', 'This email change could not be completed. Request a new link or try another address.');
      throw error;
    }
  }

  async function resetPassword(token, nextPassword) {
    // Reject guessed/expired links before spending an Argon2 work slot. The
    // transaction repeats every predicate after hashing before spending it.
    await tokenRecord(token, 'RESET_PASSWORD');
    const passwordHash = await hashPassword(nextPassword);
    return complete(token, 'RESET_PASSWORD', {passwordHash});
  }

  return {profile, updateProfile, forgotPassword, requestVerification, requestEmailChange, cancelEmailChange, verifyEmail: token => complete(token, 'VERIFY_EMAIL'), confirmEmailChange: token => complete(token, 'CHANGE_EMAIL'), resetPassword, requestAction};
}
