import {ApiError} from './http.js';

function validateFields(body, allowed, required) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(field => !allowed.includes(field)) || required.some(field => typeof body[field] !== 'string')) throw new ApiError(422, 'VALIDATION_FAILED', 'Check the highlighted fields and try again.', {details: {fields: required.map(field => ({field, message: 'Provide a valid value.'}))}});
}

export function validateCredentials(body, signup = false) {
  const fields = signup ? ['displayName', 'email', 'password'] : ['email', 'password'];
  validateFields(body, fields, fields);
  const errors = [];
  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s<>@\x00-\x1F\x7F]+@[^\s<>@\x00-\x1F\x7F]+\.[^\s<>@\x00-\x1F\x7F]+$/u.test(email)) errors.push({field: 'email', message: 'Enter a valid email address.'});
  const passwordLength = Array.from(body.password).length;
  if (!body.password.isWellFormed() || passwordLength < (signup ? 15 : 1) || passwordLength > 128) errors.push({field: 'password', message: signup ? 'Use between 15 and 128 characters.' : 'Enter your password, up to 128 characters.'});
  const displayName = signup ? body.displayName.trim().normalize('NFC') : undefined;
  if (signup && (Array.from(displayName).length < 2 || Array.from(displayName).length > 80 || /[\x00-\x1F\x7F]/u.test(displayName) || !displayName.isWellFormed())) errors.push({field: 'displayName', message: 'Use a name between 2 and 80 characters.'});
  if (errors.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Check the highlighted fields and try again.', {details: {fields: errors}});
  return {emailNormalized: email, password: body.password, ...(signup ? {displayName} : {})};
}

export function validateEmptyBody(body) {
  if (body === undefined) return;
  validateFields(body, [], []);
}
