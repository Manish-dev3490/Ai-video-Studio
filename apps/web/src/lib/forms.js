export const codePoints = value => Array.from(value).length;

export function validateAuthForm({displayName = '', email = '', password = ''}, mode) {
  const errors = {};
  if (mode === 'signup' && (codePoints(displayName.trim()) < 2 || codePoints(displayName.trim()) > 80)) errors.displayName = 'Use a name between 2 and 80 characters.';
  if (!/^[^\s@<>\x00-\x1F\x7F]+@[^\s@<>\x00-\x1F\x7F]+\.[^\s@<>\x00-\x1F\x7F]+$/u.test(email.trim()) || email.trim().length > 254) errors.email = 'Enter a valid email address.';
  const length = codePoints(password);
  if (length < (mode === 'signup' ? 15 : 1) || length > 128) errors.password = mode === 'signup' ? 'Use 15–128 characters. A memorable passphrase works well.' : 'Enter your password (up to 128 characters).';
  return errors;
}

export function safeReturnPath(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u001f]/u.test(value)) return '/app';
  try {
    const url = new URL(value, 'https://studio.invalid');
    return url.origin === 'https://studio.invalid' && (url.pathname === '/app' || url.pathname.startsWith('/app/')) ? url.pathname + url.search : '/app';
  } catch { return '/app'; }
}

export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  const code = error?.data?.error?.code;
  if (code === 'LAYOUT_REVIEW_REQUIRED' && error?.data?.error?.details?.profile === 'INTER_720P_MEASURED_ADVANCES') return 'Shorten the visual label or split long words so the text fits clearly in the video.';
  const known = {
    INVALID_CREDENTIALS: 'The email or password is incorrect. Please try again.',
    EMAIL_ALREADY_EXISTS: 'An account with this email already exists. Try signing in.',
    EMAIL_IN_USE: 'An account with this email already exists. Try signing in.',
    EMAIL_UNAVAILABLE: 'An account with this email already exists. Try signing in.',
    RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
    CSRF_INVALID: 'Your form session expired. Please try again.',
    SERVICE_UNAVAILABLE: 'The studio is temporarily unavailable. Please try again shortly.',
    VALIDATION_ERROR: 'Check the form details and try again.',
    VALIDATION_FAILED: 'Check the form details and try again.',
    AI_UNAVAILABLE: 'Script generation is unavailable right now. Your project is saved; please try again later.',
    AI_RATE_LIMITED: 'The AI writing service is busy. Your project is saved. Wait briefly before trying again.',
    AI_BUSY: 'The AI writing service is busy. Your project is saved. Wait briefly before trying again.',
    REQUEST_ABORTED: 'The request was interrupted. Your project is saved. Check for a saved result before submitting again.',
    DATABASE_UNAVAILABLE: 'Saved projects are temporarily unavailable. Please try again shortly.',
    AI_CONTEXT_UNAVAILABLE: 'The saved conversation could not be loaded for this request. Refresh the project before trying again.',
    AI_DAILY_QUOTA_EXCEEDED: 'The AI provider’s daily allowance is used. Your project and saved scripts are safe. Try again after the provider quota resets.',
    AI_PROVIDER_FAILED: 'The writing service could not finish this draft. Your project is saved. Please try again.',
    AI_TIMEOUT: 'Writing the script took too long. Check for a saved draft before generating again.',
    AI_INVALID_OUTPUT: 'The generated draft did not pass validation. Please try again or make your idea more specific.',
    CONTENT_REJECTED: 'This content cannot be used to create a video. Revise the request to a safe educational explanation.',
    CONTENT_UNAVAILABLE: 'This project is unavailable during a private safety review. You can report a concern from Account & preferences.',
    PROJECT_SAFETY_HOLD: 'This project is paused for a private safety review. You can report a concern from Account & preferences.',
    SENSITIVE_INPUT: 'Remove API keys, passwords, tokens and other private credentials before saving or sending.',
    PLANNING_IN_PROGRESS: 'A script is already being prepared for this project. Check for the saved draft shortly.',
    ASSISTANT_IN_PROGRESS: 'Wait for the current assistant reply before requesting a script revision.',
    PROJECT_CHANGED: 'The project changed while this draft was being prepared. Open its current saved script before trying again.',
    REVISION_CONFLICT: 'The saved script changed while you were editing. Your local edits are preserved. Compare or reload the saved revision.',
    STORYBOARD_IMMUTABLE: 'This script is already approved. Generate a new draft to make changes.',
    REVISION_REQUIRED: 'This script needs a revised draft and a new approval before it can render.',
    PROJECT_BUSY: 'This project has an active render. Open its progress page before making changes.',
    WORKER_UNAVAILABLE: 'Rendering is temporarily unavailable. Your approved script is saved; try again when the worker is online.',
    QUEUE_FULL: 'The render queue is full. Your approved script is saved; try again shortly.',
    QUOTA_EXCEEDED: 'Your daily generation allowance is in use. Check the remaining slots or wait for the next UTC day.',
    GENERATION_NOT_RETRYABLE: 'This attempt needs a corrected script before another render can start.',
    DURATION_FEEDBACK_UNAVAILABLE: 'Measured timing is not available for this attempt. Generate a new draft and review its narration.',
    DURATION_SOURCE_CHANGED: 'The selected script changed. Open the current saved draft before requesting a narration revision.',
    DURATION_REVISION_REQUIRED: 'The narration needs a corrected draft and fresh approval before another render.',
    DURATION_REVISION_NOT_AVAILABLE: 'This attempt does not have timing feedback that can be used for a narration revision.',
    LAYOUT_REVIEW_REQUIRED: 'Simplify the flowchart to 2–4 nodes connected once in order. Use a Steps scene for cycles or more complex connections.',
    IDEMPOTENCY_CONFLICT: 'This submission conflicts with an earlier request. Reload the project to check its latest attempt.',
    LAYOUT_TOO_DENSE: 'Shorten visual labels or use a simpler diagram. Keep titles within 70 characters and list entries within 180. Flowcharts support 2–4 nodes connected once in order; text must also fit clearly.',
    NARRATION_BUDGET: 'Adjust the narration length before approval. Aim for about 68 words at 30s, 140 at 60s, or 210 at 90s. Actual speech timing is checked during generation.',
  };
  if (known[code]) return known[code];
  if (error?.status === 429) return known.RATE_LIMITED;
  if (error?.status === 'FETCH_ERROR') return 'We could not connect to the studio. Check your connection and try again.';
  if (error?.status === 'TIMEOUT_ERROR') return 'The studio took too long to reply. Your saved project is safe. Check for a saved result before trying again.';
  const responseStatus = Number(error?.status === 'PARSING_ERROR' ? error.originalStatus : error?.status);
  if ([502, 504].includes(responseStatus)) return 'The studio connection could not finish this request. Your saved project is safe. Check for a saved result before trying again.';
  if (responseStatus >= 500) return 'The studio could not complete this request. Saved projects are preserved. Please try again shortly.';
  if (error?.status === 'PARSING_ERROR') return 'The studio response could not be read. Check for a saved result before trying again.';
  if (error?.status === 401) return 'Your session has ended. Please sign in again.';
  if (error?.status === 409) return 'An account with this email already exists. Try signing in.';
  return fallback;
}
