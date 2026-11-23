import {randomBytes} from 'node:crypto';

/** Explicit test double. The server never selects this repository. */
export function createMemoryRepository() {
  const users = new Map();
  const sessions = new Map();
  const clone = value => value ? structuredClone(value) : null;
  return {
    users,
    sessions,
    async createUser(input) {
      if ([...users.values()].some(user => user.emailNormalized === input.emailNormalized)) throw Object.assign(new Error('duplicate'), {code: 11000});
      const user = {_id: randomBytes(12).toString('hex'), authVersion: 0, emailVerifiedAt: null, ...input};
      users.set(user._id, user);
      return clone(user);
    },
    async findUserByEmail(email) { return clone([...users.values()].find(user => user.emailNormalized === email)); },
    async findUserById(id) { return clone(users.get(String(id))); },
    async createSession(input) { const session = {authVersion: 0, ...input}; sessions.set(String(input._id), clone(session)); return clone(session); },
    async getSession(id) { return clone(sessions.get(String(id))); },
    async getActiveSession(id, now) {
      const session = sessions.get(String(id));
      return session && !session.revokedAt && new Date(session.expiresAt).getTime() > now ? clone(session) : null;
    },
    async rotateSession(id, currentHash, nextHash, now, cap) {
      const session = sessions.get(String(id));
      if (!session || session.tokenHash !== currentHash || session.revokedAt || new Date(session.expiresAt).getTime() <= now || session.rotationCount >= cap) return null;
      session.usedTokenHashes.push(currentHash);
      Object.assign(session, {tokenHash: nextHash, rotatedAt: new Date(now), lastUsedAt: new Date(now), rotationCount: session.rotationCount + 1});
      return clone(session);
    },
    async revokeSession(id, now) {
      const session = sessions.get(String(id));
      if (session && !session.revokedAt) session.revokedAt = new Date(now);
      return clone(session);
    },
    async revokeIfUsedToken(id, tokenHash, now) {
      const session = sessions.get(String(id));
      if (!session || session.revokedAt || !session.usedTokenHashes.includes(tokenHash)) return null;
      session.revokedAt = new Date(now);
      return clone(session);
    },
  };
}
