import {ApiError} from '../http.js';

const invalid = fields => new ApiError(422, 'VALIDATION_FAILED', 'Check the highlighted fields and try again.', {details: {fields}});
export function strictObject(body, fields) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !fields.includes(key)) || fields.some(key => typeof body[key] !== 'string')) throw invalid(fields.map(field => ({field, message: 'Provide a valid value.'})));
  return body;
}
export function email(value) {
  const normalized = value.trim().toLowerCase();
  if (!value.isWellFormed() || normalized.length > 254 || !/^[^\s<>@\x00-\x1F\x7F]+@[^\s<>@\x00-\x1F\x7F]+\.[^\s<>@\x00-\x1F\x7F]+$/u.test(normalized)) throw invalid([{field: 'email', message: 'Enter a valid email address.'}]);
  return normalized;
}
export function displayName(value) {
  const name = value.trim().normalize('NFC');
  if (!value.isWellFormed() || Array.from(name).length < 2 || Array.from(name).length > 80 || /[\x00-\x1F\x7F]/u.test(name)) throw invalid([{field: 'displayName', message: 'Use a name between 2 and 80 characters.'}]);
  return name;
}
export function password(value, {current = false} = {}) {
  if (!value.isWellFormed() || Array.from(value).length < (current ? 1 : 15) || Array.from(value).length > 128) throw invalid([{field: current ? 'currentPassword' : 'password', message: current ? 'Enter your current password, up to 128 characters.' : 'Use between 15 and 128 characters.'}]);
  return value;
}
export const invalidLink = () => new ApiError(422, 'INVALID_ACTION_LINK', 'This link is invalid, expired or already used. Request a new link.');
export function actionToken(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/u.test(value)) throw invalidLink();
  return {id: value.slice(0, 24), token: value};
}
