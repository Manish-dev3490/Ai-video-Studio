import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import mongoose from 'mongoose';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const isPortOpen = port => new Promise(resolve => {
  const socket = net.createConnection({host: '127.0.0.1', port});
  socket.setTimeout(500);
  const finish = result => {socket.destroy(); resolve(result);};
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});

/** Starts only a dedicated loopback instance; never attaches to the Windows service. */
export async function startLocalMongo({directory, port, replicaSet = null, binary = process.env.MONGOD_BINARY || 'C:/Program Files/MongoDB/Server/7.0/bin/mongod.exe'}) {
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_LOCAL_DATABASE_OPTIONS');
  if (await isPortOpen(port)) throw new Error('LOCAL_DATABASE_PORT_IN_USE');
  await fs.access(binary);
  await fs.mkdir(path.join(directory, 'data'), {recursive: true});
  if (replicaSet && !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/u.test(replicaSet)) throw new Error('INVALID_REPLICA_SET_NAME');
  const child = spawn(binary, ['--bind_ip', '127.0.0.1', '--port', String(port), '--dbpath', path.join(directory, 'data'), '--logpath', path.join(directory, 'mongod.log'), '--logappend', '--wiredTigerCacheSizeGB', '0.25', ...(replicaSet ? ['--replSet', replicaSet, '--oplogSize', '128'] : [])], {windowsHide: true, stdio: 'ignore'});
  let spawnError;
  child.once('error', error => {spawnError = error;});
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error('LOCAL_DATABASE_START_FAILED');
    if (await isPortOpen(port)) {
      if (replicaSet) {
        let bootstrap;
        try {
          bootstrap = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, {serverSelectionTimeoutMS: 5000}).asPromise();
          try { await bootstrap.db.admin().command({replSetGetStatus: 1}); }
          catch (error) {
            if (error.code !== 94 && error.codeName !== 'NotYetInitialized') throw error;
            await bootstrap.db.admin().command({replSetInitiate: {_id: replicaSet, members: [{_id: 0, host: `127.0.0.1:${port}`}]}});
          }
          let primary = false;
          for (let election = 0; election < 100; election++) {
            const hello = await bootstrap.db.admin().command({hello: 1});
            if (hello.setName !== replicaSet) throw new Error('LOCAL_DATABASE_REPLICA_SET_MISMATCH');
            if (hello.isWritablePrimary) {primary = true; break;}
            await pause(200);
          }
          if (!primary) throw new Error('LOCAL_DATABASE_PRIMARY_TIMEOUT');
        } catch (error) {child.kill(); throw error;}
        finally {if (bootstrap) await bootstrap.close().catch(() => {});}
      }
      return {
        child, port,
        async stop() {
          if (child.exitCode !== null) return;
          let connection;
          try {
            connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/admin`, {serverSelectionTimeoutMS: 2000}).asPromise();
            await connection.db.admin().command({shutdown: 1, timeoutSecs: 3});
          } catch { /* A successful shutdown closes its own connection. */ }
          finally { if (connection) await connection.close().catch(() => {}); }
          for (let wait = 0; wait < 40 && child.exitCode === null; wait++) await pause(100);
          if (child.exitCode === null) child.kill();
        },
      };
    }
    await pause(200);
  }
  child.kill();
  throw new Error('LOCAL_DATABASE_START_TIMEOUT');
}
