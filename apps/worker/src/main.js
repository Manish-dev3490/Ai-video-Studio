import mongoose from 'mongoose';
import {loadConfig} from '../../api/src/config.js';
import {createStudioModels, initializeStudioModels} from '../../api/src/studio-models.js';
import {runWorker} from '../../api/src/jobs/worker.js';
import {cleanupExpiredMedia} from '../../api/src/media.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
// A local Node fork may request shutdown over its inherited private IPC pipe.
// No HTTP endpoint or browser message can control this worker.
process.on('message', message => {if (message?.type === 'AVS_WORKER_STOP') controller.abort();});
process.once('disconnect', () => controller.abort());
let connection;
try {
  const config = loadConfig();
  mongoose.set('bufferCommands', false);
  connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000, maxPoolSize: 8}).asPromise();
  const models = createStudioModels(connection);
  await initializeStudioModels(models);
  await runWorker({connection, config, models, signal: controller.signal, maintenance: () => cleanupExpiredMedia({models, config}), onEvent: event => process.stdout.write(JSON.stringify(event) + '\n')});
} catch (error) {
  const code = /^[A-Z0-9_]{1,80}$/u.test(error.code || error.message || '') ? error.code || error.message : 'WORKER_START_FAILED';
  process.stderr.write(JSON.stringify({code, message: 'The private video worker stopped. Check local engine setup, process isolation and database availability.'}) + '\n');
  process.exitCode = 1;
} finally {
  if (connection) await connection.close().catch(() => {});
  if (process.connected) process.disconnect();
}
