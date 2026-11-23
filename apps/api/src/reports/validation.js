import {ApiError} from '../http.js';
import {containsAssistantCredential} from '../assistant/policy.js';

export const REPORT_REASONS = ['SAFETY', 'NON_CONSENSUAL', 'IMPERSONATION', 'PRIVACY', 'OTHER'];
const invalid = () => new ApiError(422, 'VALIDATION_FAILED', 'Choose one project or asset, a report reason and a description of 1–2,000 characters.');
export function reportId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw invalid();
  return value;
}
export function privateText(value, maximum) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || Array.from(value).length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) throw invalid();
  if (containsAssistantCredential(value)) throw new ApiError(422, 'SENSITIVE_INPUT', 'Remove API keys, passwords and private credentials before submitting.');
  return value.trim();
}
export function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['projectId', 'assetId', 'reasonCode', 'description'].includes(key)) || Object.hasOwn(body, 'projectId') === Object.hasOwn(body, 'assetId') || !REPORT_REASONS.includes(body.reasonCode)) throw invalid();
  const target = Object.hasOwn(body, 'projectId') ? 'projectId' : 'assetId';
  return {[target]: reportId(body[target]), reasonCode: body.reasonCode, description: privateText(body.description, 2000)};
}
// Operator output can contain legacy data. JSON encoding handles terminal escapes;
// credential-like legacy text is withheld in full instead of printed.
export const displayPrivateText = value => typeof value !== 'string' || containsAssistantCredential(value) ? '[withheld]' : value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 4000);
export const configuredSecrets = config => ['geminiApiKey', 'resendApiKey', 'jwtSecret', 'csrfSecret', 'mailEncryptionSecret'].map(key => config[key]).filter(value => typeof value === 'string' && value.length >= 8);
export function assertNoConfiguredSecret(value, config) {
  if (configuredSecrets(config).some(secret => value.includes(secret))) throw new ApiError(422, 'SENSITIVE_INPUT', 'Remove API keys, passwords and private credentials before submitting.');
}
export function displayOperatorText(value, config) {
  let result = displayPrivateText(value);
  for (const secret of configuredSecrets(config)) result = result.split(secret).join('[withheld]');
  return result;
}
