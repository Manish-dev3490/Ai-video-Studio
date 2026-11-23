export class ApiError extends Error {
  constructor(status, code, message, {retryable = false, details} = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export function sendData(req, res, data, status = 200) {
  return res.status(status).json({data, meta: {requestId: req.requestId}});
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  let failure = error;
  if (error?.type === 'entity.parse.failed') failure = new ApiError(400, 'INVALID_JSON', 'Send a valid JSON request.');
  else if (error?.type === 'entity.too.large') failure = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
  else if (!(error instanceof ApiError)) {
    const databaseError = /Mongo|Mongoose/u.test(error?.name || '');
    failure = new ApiError(databaseError ? 503 : 500, databaseError ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR', databaseError ? 'The service is temporarily unavailable. Please try again.' : 'The request could not be completed.', {retryable: true});
  }
  const body = {error: {code: failure.code, message: failure.message, retryable: failure.retryable}, requestId: req.requestId};
  if (failure.status === 429 && !res.getHeader('Retry-After')) {
    const providerDelay = failure.code === 'AI_DAILY_QUOTA_EXCEEDED' ? failure.details?.retryAfterSeconds : null;
    res.set('Retry-After', Number.isSafeInteger(providerDelay) && providerDelay >= 1 && providerDelay <= 86400 ? String(providerDelay) : '2');
  }
  if (failure.details !== undefined) body.error.details = failure.details;
  return res.status(failure.status).json(body);
}
