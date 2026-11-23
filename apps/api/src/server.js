import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import {loadConfig} from './config.js';
import {createMongoRepository} from './repository.js';
import {createApp} from './app.js';
import {buildDashboardRouter} from './dashboard.js';
import {createStudioModels, initializeStudioModels} from './studio-models.js';
import {buildStudioRouter} from './studio.js';
import {cleanupExpiredMedia} from './media.js';
import {cleanupWorkerArtifacts} from './jobs/worker.js';
import {startMailDispatcher} from './mail.js';
import {cleanupAssistantHistory} from './assistant/index.js';
import {createReadinessCheck} from './production-runtime.js';

const supervised = Boolean(process.channel);

async function main() {
  const config = loadConfig();
  mongoose.set('bufferCommands', false);
  const connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000, maxPoolSize: 10, autoIndex: true}).asPromise();
  const repository = createMongoRepository(connection);
  await repository.initialize();
  const models = createStudioModels(connection);
  await initializeStudioModels(models);
  const studioRouter = buildStudioRouter({connection, config, models});
  const dashboardRouter = buildDashboardRouter({connection, config});
  const app = createApp({config, repository, dashboardRouter, studioRouter, readinessCheck: createReadinessCheck({connection}), staticDirectory: fileURLToPath(new URL('../../web/dist/', import.meta.url))});
  await app.locals.account.initialize();
  const server = app.listen(config.apiPort, config.apiHost);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }
  process.stdout.write(`AI Video Studio API listening on ${config.apiHost}:${config.apiPort}\n`);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let stopping = false;
  const mail = startMailDispatcher({models: app.locals.account.models, config});
  let cleaning = false;
  const cleanup = setInterval(async () => {
    if (cleaning) return;
    cleaning = true;
    try {await cleanupExpiredMedia({models, config}); await cleanupWorkerArtifacts({models, config}); await cleanupAssistantHistory({models});} catch { /* A later bounded maintenance pass retries safely. */ }
    finally {cleaning = false;}
  }, 30000).unref();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await mail.stop();
      await connection.close().catch(() => {});
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Only the inherited private IPC channel may request supervisor shutdown.
  if (supervised) {
    process.on('message', message => {if (message?.type === 'AVS_API_STOP') stop();});
    if (process.connected) process.once('disconnect', stop);
    else stop(); // A supervisor may disconnect while database startup is pending.
  }
}

main().catch(() => {
  process.stderr.write('API startup failed. Check the local configuration and MongoDB connection. No environment values were logged.\n');
  process.exitCode = 1;
});
