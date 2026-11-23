const normalized = args => typeof args === 'string' ? {url: args, method: 'GET'} : {...args, method: (args.method || 'GET').toUpperCase()};
const isMutation = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const authWrite = url => /^\/auth\/(signup|login|refresh|logout|forgot-password|reset-password|verify-email|confirm-email-change)$/u.test(url);

/** Cookies stay in the browser. Only the non-secret CSRF proof lives here. */
export function createSessionTransport(request, {locks = globalThis.navigator?.locks} = {}) {
  let csrfToken;
  let refreshPromise;
  let localLock = Promise.resolve();
  const locked = work => {
    if (locks?.request) return locks.request('avs-session-refresh', work);
    const operation = localLock.then(work, work);
    localLock = operation.then(() => {}, () => {});
    return operation;
  };

  async function csrf(api, extra) {
    if (csrfToken) return {token: csrfToken};
    const result = await request('/auth/csrf', api, extra);
    if (result.error) return result;
    const token = result.data?.data?.csrfToken;
    if (typeof token !== 'string' || !token) return {error: {status: 'CUSTOM_ERROR', error: 'Session initialization failed.'}};
    csrfToken = token;
    return {token};
  }

  async function send(input, api, extra, retryCsrf = true) {
    const args = normalized(input);
    if (isMutation(args.method)) {
      const proof = await csrf(api, extra);
      if (proof.error) return proof;
      args.headers = new Headers(args.headers);
      args.headers.set('X-CSRF-Token', proof.token);
    }
    const result = await request(args, api, extra);
    if (!result.error && isMutation(args.method) && authWrite(args.url)) csrfToken = undefined;
    if (retryCsrf && result.error?.status === 403 && result.error.data?.error?.code === 'CSRF_INVALID') {
      csrfToken = undefined;
      return send(input, api, extra, false);
    }
    return result;
  }

  async function refresh(api, extra) {
    if (!refreshPromise) {
      refreshPromise = locked(async () => {
        // Another tab may already have refreshed while this one waited.
        const current = await request('/auth/me', api, extra);
        if (!current.error || current.error.status !== 401) return current;
        return send({url: '/auth/refresh', method: 'POST', body: {}}, api, extra);
      });
      refreshPromise = Promise.resolve(refreshPromise).finally(() => { refreshPromise = undefined; });
    }
    return refreshPromise;
  }

  return async (input, api, extra) => {
    const args = normalized(input);
    if (authWrite(args.url) && isMutation(args.method)) return locked(() => send(args, api, extra));
    if (refreshPromise) await refreshPromise;
    const result = await send(args, api, extra);
    if (result.error?.status !== 401 || args.url === '/auth/csrf') return result;
    const renewed = await refresh(api, extra);
    if (renewed.error) return renewed.error.status === 401 ? result : renewed;
    return send(args, api, extra);
  };
}
