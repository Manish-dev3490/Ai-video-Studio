import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork, spawn} from 'node:child_process';
import {readProfile, assessLocalProfile, initializeLocalProfile, defaultProfileFile, localMongoUri, repositoryRoot} from '../ops/production/profile.mjs';
import {checkProductionProfile} from './production-check.mjs';
import {ensureDirectoryUnder} from '../apps/api/src/jobs/files.js';
import {startLocalMongo, isPortOpen} from './local-mongo.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export function productionChildEnvironment(environment, worker = false) {
  const osEnvironment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) if (process.env[name]) osEnvironment[name] = process.env[name];
  const result = {...osEnvironment, ...environment};
  if (worker) {
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'RESEND_API_KEY', 'MAIL_ENCRYPTION_SECRET']) delete result[name];
    result.MAIL_TRANSPORT = 'disabled';
  }
  return result;
}
export function parseProductionArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--env-file' && !options.file && args[index + 1]) options.file = args[++index];
    else if (args[index] === '--init' && !options.initialize) options.initialize = true;
    else if (args[index] === '--help') options.help = true;
    else throw new Error('INVALID_PRODUCTION_ARGUMENTS');
  }
  return options;
}

/** Foreground, owned-child supervisor. No global services, firewall or tunnel. */
export async function startProduction({file = defaultProfileFile, onEvent = event => process.stdout.write(JSON.stringify(event) + '\n')} = {}) {
  const inspection = await checkProductionProfile({file, native: true});
  if (!inspection.passed) {onEvent({event: 'LOCAL_PRODUCTION_PREFLIGHT_FAILED', inspection}); throw new Error('PRODUCTION_PREFLIGHT_FAILED');}
  const environment = await readProfile(file), assessment = assessLocalProfile(environment);
  const {config} = assessment;
  const gatewayPort = Number(assessment.origin.port || 443);
  if (await isPortOpen(config.apiPort) || await isPortOpen(gatewayPort)) throw new Error('PRODUCTION_PORT_IN_USE');
  const children = [];
  let mongo, gateway, stopping = false, stopPromise;
  const interrupt = () => void stop(0);
  const stopMessage = message => {if (message?.type === 'AVS_PRODUCTION_STOP') interrupt();};
  function detach() {process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); process.off('disconnect', interrupt); process.off('message', stopMessage);}
  function stop(exitCode = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
    if (gateway) await new Promise(resolve => {gateway.close(resolve); gateway.closeAllConnections?.();});
    for (const child of [...children].reverse()) {
      if (child.connected) child.send({type: child.avsWorker ? 'AVS_WORKER_STOP' : 'AVS_API_STOP'});
      const maximum = child.avsWorker ? 300 : 120;
      for (let count = 0; count < maximum && child.exitCode === null; count++) await pause(100);
      if (child.exitCode === null) {
        // Only this supervisor's still-owned child tree, never a name/port match.
        if (process.platform === 'win32') await new Promise(resolve => {const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}); kill.once('error', resolve); kill.once('exit', resolve);});
        else child.kill('SIGTERM');
      }
    }
    if (mongo) await mongo.stop();
    process.exitCode = exitCode;
    detach();
    onEvent({event: 'LOCAL_PRODUCTION_STOPPED'});
    })();
    return stopPromise;
  }
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  if (process.send) process.once('disconnect', interrupt);
  process.on('message', stopMessage);
  try {
    for (const directory of [config.storageRoot, config.workerWorkRoot]) await ensureDirectoryUnder(repositoryRoot, directory);
    if (environment.AUTO_START_LOCAL_MONGO === 'true') {
      if (config.mongoUri !== localMongoUri) throw new Error('AUTO_MONGO_REQUIRES_DEDICATED_LOCAL_URI');
      const directory = path.join(repositoryRoot, 'var/production/mongodb');
      await ensureDirectoryUnder(repositoryRoot, directory);
      mongo = await startLocalMongo({directory, port: 27019, replicaSet: 'avsProductionLocal', ...(environment.MONGOD_BINARY ? {binary: environment.MONGOD_BINARY} : {})});
      if (stopping) {await mongo.stop(); throw new Error('PRODUCTION_START_CANCELLED');}
    }
    const databaseCheck = await checkProductionProfile({file, database: true});
    if (!databaseCheck.passed) {onEvent({event: 'LOCAL_PRODUCTION_DATABASE_UNAVAILABLE', inspection: databaseCheck}); throw new Error('PRODUCTION_DATABASE_NOT_READY');}
    const launch = (entry, worker) => {
      if (stopping) throw new Error('PRODUCTION_START_CANCELLED');
      const child = fork(path.join(repositoryRoot, entry), [], {cwd: repositoryRoot, env: productionChildEnvironment(environment, worker), execArgv: [], windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
      child.avsWorker = worker; children.push(child);
      child.once('error', () => {if (!stopping) void stop(1);});
      child.once('exit', code => {if (!stopping) void stop(code || 1);});
      return child;
    };
    launch('apps/api/src/server.js', false);
    let ready = false;
    for (let count = 0; count < 75 && !stopping; count++) {
      try {const response = await fetch(`http://127.0.0.1:${config.apiPort}/api/v1/ready`, {signal: AbortSignal.timeout(750)}); if (response.status === 200) {ready = true; break;}} catch { /* Startup remains bounded. */ }
      await pause(200);
    }
    if (!ready) throw new Error('PRODUCTION_API_NOT_READY');
    launch('apps/worker/src/main.js', true);
    const {startLocalGateway} = await import('../ops/production/local-gateway.mjs');
    gateway = await startLocalGateway({origin: config.appOrigin, apiPort: config.apiPort, certFile: environment.LOCAL_TLS_CERT_FILE, keyFile: environment.LOCAL_TLS_KEY_FILE});
    if (stopping) {await new Promise(resolve => {gateway.close(resolve); gateway.closeAllConnections?.();}); throw new Error('PRODUCTION_START_CANCELLED');}
    onEvent({event: 'LOCAL_PRODUCTION_ONLINE', origin: config.appOrigin, publicDeployment: false, mailEnabled: config.mailMode === 'resend', certificateTrust: 'LOCAL_SELF_SIGNED_ONLY'});
    return {stop, children, gateway};
  } catch (error) {await stop(1); throw error;}
}

async function main() {
  let supervisor;
  try {
    const options = parseProductionArguments(process.argv.slice(2));
    if (options.help) {process.stdout.write('start-production.mjs [--env-file ignored-file] [--init]\n--init creates an independent private localhost profile and certificate once.\nNormal mode starts the production build, private worker, local TLS gateway and dedicated local replica set. No services, packages or firewall changes are installed.\n'); return;}
    if (options.initialize) {const result = await initializeLocalProfile({file: options.file}); process.stdout.write(JSON.stringify({event: 'LOCAL_PROFILE_INITIALIZED', ...result, defaultFile: options.file ? undefined : '.env.production.local', publicDeployment: false}) + '\n'); return;}
    supervisor = await startProduction(options);
  } catch {process.stderr.write('Local production startup failed. Run production-check.mjs for sanitized prerequisites. Existing development configuration and data were not overwritten.\n'); process.exitCode = 1;}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
