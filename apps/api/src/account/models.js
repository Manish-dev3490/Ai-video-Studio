import mongoose from 'mongoose';

export const ACTION_PURPOSES = Object.freeze(['VERIFY_EMAIL', 'RESET_PASSWORD', 'CHANGE_EMAIL']);
export function createAccountModels(connection) {
  const {Schema} = mongoose;
  const version = {type: Number, required: true, min: 0, validate: Number.isSafeInteger};
  const actionSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    purpose: {type: String, enum: ACTION_PURPOSES, required: true},
    emailNormalized: {type: String, required: true},
    targetEmailNormalized: {type: String, default: null},
    authVersion: version,
    tokenHash: {type: String, required: true, match: /^[a-f0-9]{64}$/u},
    issuedAt: {type: Date, required: true},
    expiresAt: {type: Date, required: true},
    usedAt: {type: Date, default: null},
  }, {timestamps: true, versionKey: false, strict: 'throw', collection: 'accountActionTokens'});
  actionSchema.index({userId: 1, purpose: 1}, {unique: true});
  actionSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});
  const outboxSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    purpose: {type: String, enum: [...ACTION_PURPOSES, 'SECURITY_NOTICE'], required: true},
    actionId: {type: Schema.Types.ObjectId, default: null},
    tokenHash: {type: String, match: /^[a-f0-9]{64}$/u, default: null},
    authVersion: version,
    payload: {type: Schema.Types.Mixed, required: function () {return ['QUEUED', 'SENDING'].includes(this.status);}},
    expiresAt: {type: Date, required: true},
    status: {type: String, enum: ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'], default: 'QUEUED', required: true},
    attempts: {type: Number, default: 0, min: 0, validate: Number.isSafeInteger},
    nextAttemptAt: {type: Date, default: Date.now},
    leaseUntil: {type: Date, default: null},
    deliveryToken: {type: String, default: null},
    sentAt: {type: Date, default: null},
    providerMessageId: {type: String, default: null, match: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u},
    providerAcceptedAt: {type: Date, default: null},
    lastErrorCode: {type: String, default: null},
  }, {timestamps: true, versionKey: false, strict: 'throw', collection: 'mailOutbox'});
  outboxSchema.index({status: 1, nextAttemptAt: 1, leaseUntil: 1});
  outboxSchema.index({userId: 1, purpose: 1, status: 1});
  outboxSchema.index({expiresAt: 1}, {expireAfterSeconds: 604800});
  const ActionToken = connection.models.AccountActionToken || connection.model('AccountActionToken', actionSchema);
  const MailOutbox = connection.models.MailOutbox || connection.model('MailOutbox', outboxSchema);
  return {ActionToken, MailOutbox};
}

export async function initializeAccountModels(models) {
  await models.ActionToken.init();
  await models.MailOutbox.init();
}
