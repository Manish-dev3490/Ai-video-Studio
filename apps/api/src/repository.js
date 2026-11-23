import mongoose from 'mongoose';

export const publicUser = user => ({id: String(user._id), displayName: user.displayName, email: user.emailNormalized});

export function createMongoRepository(connection) {
  const {Schema} = mongoose;
  const userSchema = new Schema({
    displayName: {type: String, required: true, trim: true, validate: value => Array.from(value).length >= 2 && Array.from(value).length <= 80},
    emailNormalized: {type: String, required: true, trim: true, lowercase: true, maxlength: 254},
    passwordHash: {type: String, required: true, select: false},
    authVersion: {type: Number, default: 0, required: true, min: 0, validate: Number.isSafeInteger},
    emailVerifiedAt: {type: Date, default: null},
    role: {type: String, enum: ['USER'], default: 'USER', required: true},
    status: {type: String, enum: ['ACTIVE', 'SUSPENDED', 'DELETION_PENDING'], default: 'ACTIVE', required: true},
  }, {timestamps: true, versionKey: false, strict: 'throw', collection: 'users'});
  userSchema.index({emailNormalized: 1}, {unique: true});
  const sessionSchema = new Schema({
    userId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    authVersion: {type: Number, default: 0, required: true, min: 0, validate: Number.isSafeInteger},
    tokenHash: {type: String, required: true, match: /^[a-f0-9]{64}$/u, select: false},
    familyId: {type: String, required: true},
    usedTokenHashes: {type: [String], default: [], select: false},
    rotationCount: {type: Number, default: 0, required: true, min: 0, max: 2048, validate: Number.isSafeInteger},
    expiresAt: {type: Date, required: true},
    rotatedAt: {type: Date, default: null},
    revokedAt: {type: Date, default: null},
    lastUsedAt: {type: Date, default: null},
    createdAt: {type: Date, required: true},
  }, {versionKey: false, strict: 'throw', collection: 'sessions'});
  sessionSchema.index({tokenHash: 1}, {unique: true});
  sessionSchema.index({userId: 1, revokedAt: 1});
  sessionSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});
  const User = connection.models.User || connection.model('User', userSchema);
  const Session = connection.models.Session || connection.model('Session', sessionSchema);
  const plain = document => document?.toObject ? document.toObject() : document;
  return {
    connection,
    models: {User, Session},
    isReady: () => connection.readyState === 1,
    async initialize() { await Promise.all([User.init(), Session.init()]); },
    async createUser(input) { return plain(await User.create(input)); },
    async findUserByEmail(emailNormalized) { return User.findOne({emailNormalized}).select('+passwordHash').lean(); },
    async findUserById(id) { return User.findById(id).lean(); },
    async createSession(input) { return plain(await Session.create(input)); },
    async getSession(id) { return Session.findById(id).select('+tokenHash +usedTokenHashes').lean(); },
    async getActiveSession(id, now) { return Session.findOne({_id: id, revokedAt: null, expiresAt: {$gt: new Date(now)}}).lean(); },
    async rotateSession(id, currentHash, nextHash, now, maxRotations) {
      return Session.findOneAndUpdate({_id: id, tokenHash: currentHash, revokedAt: null, expiresAt: {$gt: new Date(now)}, rotationCount: {$lt: maxRotations}}, {$set: {tokenHash: nextHash, rotatedAt: new Date(now), lastUsedAt: new Date(now)}, $push: {usedTokenHashes: currentHash}, $inc: {rotationCount: 1}}, {returnDocument: 'after'}).select('+tokenHash +usedTokenHashes').lean();
    },
    async revokeSession(id, now) { return Session.findOneAndUpdate({_id: id, revokedAt: null}, {$set: {revokedAt: new Date(now)}}, {returnDocument: 'after'}).lean(); },
    async revokeIfUsedToken(id, tokenHash, now) { return Session.findOneAndUpdate({_id: id, usedTokenHashes: tokenHash, revokedAt: null}, {$set: {revokedAt: new Date(now)}}, {returnDocument: 'after'}).lean(); },
  };
}
