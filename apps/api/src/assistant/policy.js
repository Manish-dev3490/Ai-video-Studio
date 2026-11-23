import {ApiError} from '../http.js';
import {assertSafeContent} from '../safety/content.js';

const forbiddenControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const secretPatterns = [
  /(?:^|[^A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/u,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/u,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/u,
  /\bre_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})(?![A-Za-z0-9_])/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/u,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/u,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/u,
  /\b(?:api[_ -]?key|client[_ -]?secret|password|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{16,}/iu,
];

function validText(value, maximum) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || Array.from(value).length > maximum || forbiddenControls.test(value)) {
    throw new ApiError(422, 'VALIDATION_FAILED', `Use a nonblank message of at most ${maximum.toLocaleString('en-US')} characters without unsupported control characters.`);
  }
  return value.trim();
}

export function containsAssistantCredential(value) {
  const shadow = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '');
  return secretPatterns.some(pattern => pattern.test(shadow));
}

/** Rechecks legacy saved context before any part of it reaches the provider. */
export function assertAssistantContextText(value, maximum = 4000) {
  const text = validText(value, maximum);
  if (containsAssistantCredential(text)) throw new ApiError(422, 'SENSITIVE_INPUT', 'Remove API keys, passwords and private credentials before sending this message.');
  return assertSafeContent(text);
}

export function assertAssistantInput(value) {
  const text = assertAssistantContextText(value, 2000);
  return text;
}
