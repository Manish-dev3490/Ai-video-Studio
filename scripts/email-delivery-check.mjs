import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {loadConfig} from '../apps/api/src/config.js';
import {createMailTransport, readEmailDeliveryStatus, readEmailDomainStatus, validMailProviderId} from '../apps/api/src/mail.js';

const validAddress = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+\.[^\s<>@\x00-\x1f\x7f]+$/u.test(value);
const invalid = () => Object.assign(new Error('Use --help for the explicit email-check arguments.'), {code: 'INVALID_EMAIL_CHECK_ARGUMENTS'});
export const emailCheckHelp = `Email delivery checks (no network or email side effects by default)
  node --env-file-if-exists=.env scripts/email-delivery-check.mjs
  ... --send --to APPROVED_TEST_INBOX [--request-id 24_HEX_CHARACTERS]
  ... --status PROVIDER_EMAIL_UUID
  ... --domain-status PROVIDER_DOMAIN_UUID
Only --send sends a plain-text operator test; it contains no account action link.
Supply the same --request-id, recipient and configuration to recover an uncertain
send within the provider's idempotency window. Do not automatically resend.
Status/domain reads require sufficient provider API permissions. Provider acceptance
is not delivery; provider delivery is not confirmation of inbox placement/read.
Credentials belong in the ignored environment file, never in these arguments.
`;

export function parseEmailCheckArguments(args) {
  if (!args.length) return {mode: 'check'};
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {mode: 'help'};
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--send', '--to', '--request-id', '--status', '--domain-status'].includes(key) || Object.hasOwn(options, key)) throw invalid();
    if (key === '--send') options[key] = true;
    else {const value = args[++index]; if (!value || value.startsWith('--')) throw invalid(); options[key] = value;}
  }
  if (options['--send']) {
    if (options['--status'] || options['--domain-status'] || !validAddress(options['--to']) || options['--request-id'] && !/^[a-f0-9]{24}$/u.test(options['--request-id'])) throw invalid();
    return {mode: 'send', recipient: options['--to'], requestId: options['--request-id'] || randomBytes(12).toString('hex')};
  }
  if (options['--status'] && Object.keys(options).length === 1 && validMailProviderId(options['--status'])) return {mode: 'status', id: options['--status']};
  if (options['--domain-status'] && Object.keys(options).length === 1 && validMailProviderId(options['--domain-status'])) return {mode: 'domain-status', id: options['--domain-status']};
  throw invalid();
}

export async function runEmailCheck(config, options, {fetchImpl = globalThis.fetch} = {}) {
  const sender = config.mailFrom?.match(/<([^<>]+)>\s*$/u)?.[1] || config.mailFrom;
  const checks = {transportIsResend: config.mailMode === 'resend', providerKeyConfigured: Boolean(config.resendApiKey), senderConfigured: validAddress(sender) && !/\.(?:invalid|test)$/iu.test(sender), httpsAppOrigin: /^https:\/\//u.test(config.appOrigin || ''), independentMailEncryptionConfigured: Boolean(config.mailEncryptionSecret), verifiedSenderDomainConfirmed: false};
  if (options.mode === 'check') return {mode: 'CONFIGURATION_ONLY', networkRequests: 0, sent: false, checks, readyForExplicitSend: checks.transportIsResend && checks.providerKeyConfigured && checks.senderConfigured, productionDeliveryVerified: false};
  if (options.mode === 'status') return {mode: 'READ_ONLY_EMAIL_STATUS', ...(await readEmailDeliveryStatus(config, options.id, {fetchImpl})), sent: false};
  if (options.mode === 'domain-status') return {mode: 'READ_ONLY_DOMAIN_STATUS', ...(await readEmailDomainStatus(config, options.id, {fetchImpl})), sent: false};
  if (options.mode !== 'send' || !validAddress(options.recipient) || !/^[a-f0-9]{24}$/u.test(options.requestId) || !checks.transportIsResend || !checks.providerKeyConfigured || !checks.senderConfigured) throw Object.assign(new Error('Configure the Resend transport and sender before an explicit test.'), {code: 'EMAIL_CHECK_NOT_CONFIGURED'});
  const result = await createMailTransport(config, {fetchImpl})({from: config.mailFrom, to: options.recipient, subject: 'AI Video Studio delivery test', text: `AI Video Studio operator delivery test.\n\nReference: ${options.requestId}\n\nThis is an explicitly requested test message. It contains no sign-in, verification or password-reset link. If you received it in your inbox, confirm the reference with the operator.`}, {messageId: options.requestId});
  return {mode: 'EXPLICIT_TEST_SEND', requestId: options.requestId, providerMessageId: result.providerMessageId, providerAccepted: true, providerDeliveryConfirmed: false, inboxConfirmed: false, nextStep: 'Check the approved test inbox, or use --status with the provider message ID if API permissions allow.'};
}

async function main() {
  let options;
  try {
    options = parseEmailCheckArguments(process.argv.slice(2));
    if (options.mode === 'help') {process.stdout.write(emailCheckHelp); return;}
    const result = await runEmailCheck(loadConfig(), options);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    const code = /^(?:EMAIL_[A-Z_]+|MAIL_PAYLOAD_INVALID|INVALID_EMAIL_CHECK_ARGUMENTS)$/u.test(error.code || '') ? error.code : 'EMAIL_CHECK_FAILED';
    process.stderr.write(JSON.stringify({code, ...(options?.mode === 'send' ? {requestId: options.requestId, providerOutcome: 'UNCONFIRMED_DO_NOT_AUTOMATICALLY_RESEND'} : {}), message: 'Email check could not complete. Check private configuration/permissions and use --help. No credentials or provider bodies were logged.'}) + '\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
