import {ApiError} from '../http.js';
import {containsAssistantCredential} from '../assistant/policy.js';
import {assertSafeContent} from './content.js';

export {assertSafeContent} from './content.js';

export function assertProjectSafetyAvailable(project) {
  if (project?.safetyHoldAt) throw new ApiError(409, 'PROJECT_SAFETY_HOLD', 'This project is temporarily restricted for a private safety review. You can still report a concern or delete the project when its render has stopped.');
}

/** Validate every scene string, including visible labels nested in template data. */
export function assertStoryboardSafety(storyboard) {
  const strings = [];
  const visit = value => {
    if (typeof value === 'string') {
      strings.push(value);
      if (containsAssistantCredential(value)) throw new ApiError(422, 'SENSITIVE_INPUT', 'Remove credentials and private keys from the storyboard before continuing.');
      assertSafeContent(value);
    } else if (Array.isArray(value)) for (const entry of value) visit(entry);
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) visit(entry);
  };
  visit(storyboard?.scenes);
  assertSafeContent(strings.join(' '));
  return storyboard;
}
