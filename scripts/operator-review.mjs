import {fileURLToPath} from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import {loadConfig} from '../apps/api/src/config.js';
import {createStudioModels} from '../apps/api/src/studio-models.js';
import {createOperatorReviewService} from '../apps/api/src/reports/operator.js';

export const operatorHelp = `Private operator review (trusted local terminal and database credentials only)
  list [--status OPEN|REVIEWED|RESOLVED] [--limit 1..50]
  show --id REPORT_ID
  review|resolve|hold|release --id REPORT_ID --revision N --operator OPERATOR_ID --note "Reason"
Read a case's current revision before every change. Hold cancels queued work,
requests running work to stop and revokes project media access. Release does not
restart work. Resolve does not release an existing hold. Reports have no public queue.
Operator labels are audit attribution, not authentication; protect local/DB access.
`;

export function parseOperatorArguments(args) {
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return {command: 'help'};
  const [command, ...tail] = args;
  if (!['list', 'show', 'review', 'resolve', 'hold', 'release'].includes(command) || tail.length % 2) throw new Error('INVALID_OPERATOR_ARGUMENTS');
  const options = {};
  const allowed = command === 'list' ? ['--status', '--limit'] : command === 'show' ? ['--id'] : ['--id', '--revision', '--operator', '--note'];
  for (let index = 0; index < tail.length; index += 2) {
    const flag = tail[index], value = tail[index + 1];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) || !value || value.startsWith('--')) throw new Error('INVALID_OPERATOR_ARGUMENTS');
    options[flag] = value;
  }
  if (command === 'list') {
    const status = options['--status'] ?? 'OPEN', limit = options['--limit'] ?? '20';
    if (!['OPEN', 'REVIEWED', 'RESOLVED'].includes(status) || !/^(?:[1-9]|[1-4]\d|50)$/u.test(limit)) throw new Error('INVALID_OPERATOR_ARGUMENTS');
    return {command, status, limit: Number(limit)};
  }
  if (!/^[a-f0-9]{24}$/u.test(options['--id'] || '')) throw new Error('INVALID_OPERATOR_ARGUMENTS');
  if (command === 'show') return {command, id: options['--id']};
  if (!/^(?:0|[1-9]\d{0,8})$/u.test(options['--revision'] || '') || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{1,79}$/u.test(options['--operator'] || '') || !options['--note']) throw new Error('INVALID_OPERATOR_ARGUMENTS');
  return {command, id: options['--id'], action: command.toUpperCase(), expectedRevision: Number(options['--revision']), operatorId: options['--operator'], note: options['--note']};
}

async function main() {
  let connection;
  try {
    const options = parseOperatorArguments(process.argv.slice(2));
    if (options.command === 'help') {process.stdout.write(operatorHelp); return;}
    const config = loadConfig();
    connection = await mongoose.createConnection(config.mongoUri, {serverSelectionTimeoutMS: 5000, maxPoolSize: 2, autoIndex: false}).asPromise();
    const service = createOperatorReviewService({connection, config, models: createStudioModels(connection)});
    const result = options.command === 'list' ? await service.list(options) : options.command === 'show' ? await service.show(options.id) : await service.act(options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    // Never print connection strings, raw database failures, prompts or env values.
    process.stderr.write(error.name === 'ApiError' ? `${error.code}: ${error.message}\n` : 'Operator review could not run. Check arguments and private local database configuration. Use --help for usage.\n');
    process.exitCode = 1;
  } finally {if (connection) await connection.close().catch(() => {});}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
