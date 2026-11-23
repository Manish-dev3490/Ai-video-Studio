import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import {readProfile, assessLocalProfile, defaultProfileFile} from '../ops/production/profile.mjs';

export async function checkProductionProfile({file = defaultProfileFile, native = false, database = false, publicLaunch = false} = {}) {
  const environment = await readProfile(file), assessment = assessLocalProfile(environment);
  const result = {profile: 'LOCAL_PRODUCTION', configuration: {passed: assessment.passed, issues: assessment.issues}, native: {requested: native, checked: false, passed: null, issues: []}, database: {requested: database, checked: false, passed: null, issues: []}, realEmailConfigured: environment.MAIL_TRANSPORT === 'resend' && Boolean(environment.RESEND_API_KEY) && Boolean(environment.MAIL_FROM), publicDeployment: false, sendsEmail: false, downloadsOrInstalls: false};
  if (publicLaunch) result.configuration.issues.push('LOCAL_PROFILE_IS_NOT_A_PUBLIC_DEPLOYMENT');
  if (!assessment.passed || publicLaunch) {result.configuration.passed = false; result.passed = false; return result;}
  if (native) {
    result.native.checked = true;
    const {config} = assessment;
    if (process.platform !== 'win32') result.native.issues.push('WINDOWS_WORKER_REQUIRED');
    const major = Number(process.versions.node.split('.')[0]), minor = Number(process.versions.node.split('.')[1]);
    if (!(major === 22 && minor >= 13 || major >= 24)) result.native.issues.push('SUPPORTED_NODE_VERSION_REQUIRED');
    for (const [name, file] of [['INSTALLED_CHROME_REQUIRED', config.browserExecutable], ['POWERSHELL7_REQUIRED', config.powershellExecutable], ['FRONTEND_BUILD_REQUIRED', path.join(config.repositoryRoot, 'apps/web/dist/index.html')], ['LOCAL_TLS_CERTIFICATE_REQUIRED', environment.LOCAL_TLS_CERT_FILE], ['LOCAL_TLS_KEY_REQUIRED', environment.LOCAL_TLS_KEY_FILE]]) {
      try {if (!path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw new Error();} catch {result.native.issues.push(name);}
    }
    try {const {readLocalCertificate} = await import('./local-production-certificate.mjs'); await readLocalCertificate({certFile: environment.LOCAL_TLS_CERT_FILE, keyFile: environment.LOCAL_TLS_KEY_FILE, hostname: assessment.origin.hostname});} catch {result.native.issues.push('VALID_LOCAL_TLS_PAIR_REQUIRED');}
    try {const engine = await import(new URL('../packages/video-engine/scripts/setup-kokoro.js', import.meta.url)); await engine.verifyKokoroSetup(config.kokoroModelPath || engine.DEFAULT_MODEL_PATH);} catch {result.native.issues.push('VERIFIED_LOCAL_KOKORO_REQUIRED');}
    result.native.passed = result.native.issues.length === 0;
  }
  if (database) {
    result.database.checked = true;
    let connection;
    try {
      connection = await mongoose.createConnection(assessment.config.mongoUri, {serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, maxPoolSize: 1, autoIndex: false}).asPromise();
      const hello = await connection.db.admin().command({hello: 1});
      if (!hello.isWritablePrimary || !hello.setName || !Number.isFinite(hello.logicalSessionTimeoutMinutes)) result.database.issues.push('WRITABLE_REPLICA_SET_REQUIRED');
    } catch {result.database.issues.push('DATABASE_UNAVAILABLE');}
    finally {if (connection) await connection.close().catch(() => {});}
    result.database.passed = result.database.issues.length === 0;
  }
  result.passed = result.configuration.passed && (!native || result.native.passed) && (!database || result.database.passed);
  return result;
}

export function parseCheckArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--env-file' && !options.file && args[index + 1]) options.file = args[++index];
    else if (flag === '--native' && !options.native) options.native = true;
    else if (flag === '--database' && !options.database) options.database = true;
    else if (flag === '--public' && !options.publicLaunch) options.publicLaunch = true;
    else if (flag === '--help') options.help = true;
    else throw new Error('INVALID_PRODUCTION_CHECK_ARGUMENTS');
  }
  return options;
}

async function main() {
  try {
    const options = parseCheckArguments(process.argv.slice(2));
    if (options.help) {process.stdout.write('production-check.mjs [--env-file ignored-file] [--native] [--database] [--public]\nDefault: local configuration only, no provider requests, database writes or installation.\n'); return;}
    const result = await checkProductionProfile(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); if (!result.passed) process.exitCode = 1;
  } catch (error) {process.stderr.write(JSON.stringify({passed: false, code: error.code === 'ENOENT' ? 'PRODUCTION_PROFILE_MISSING' : 'PRODUCTION_CHECK_FAILED', message: 'Initialize a private local profile, check the selected file and run --help. No secrets were printed.'}) + '\n'); process.exitCode = 1;}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
