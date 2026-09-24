import {
  AUTH_TOKEN_STORAGE_KEY,
  LEGACY_AUTH_TOKEN_STORAGE_KEY,
} from '../components/auth/constants';

/**
 * Tolerance for client/server clock skew. The server's own verification is the
 * real authority; this check only decides whether the client should discard a
 * token locally. Without an allowance, a browser clock running slightly ahead
 * reads a still-server-valid token as expired and drops a fresh session.
 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Shape check for a token we did not issue ourselves in this call (e.g. an
 * `X-Refreshed-Token` response header). Only a value with this app's issued JWT
 * shape — three base64url segments — may overwrite the stored auth token, so an
 * attacker-injected or malformed header can never silently replace it.
 */
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

/**
 * Decodes the JWT payload and reports whether it is already past its `exp`,
 * allowing for client clock skew. Anything unparseable counts as expired so we
 * never send garbage to the server.
 */
const readTokenClaims = (token: string): { iat?: number; exp?: number } | null => {
  try {
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) {
      return null;
    }

    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(normalized)) as { iat?: number; exp?: number };
  } catch {
    return null;
  }
};

export const isTokenExpired = (token: string): boolean => {
  const exp = readTokenClaims(token)?.exp;
  return typeof exp !== 'number' || exp * 1000 + TOKEN_EXPIRY_SKEW_MS <= Date.now();
};

/**
 * One-time migration from the legacy key. A still-valid legacy token moves to
 * the new key so the user is not logged out by the rename; an expired one is
 * simply dropped. The legacy key is always removed so code from the previous
 * bundle (old tab, installed PWA) has nothing left to fight over.
 */
const migrateLegacyToken = (): void => {
  const legacy = localStorage.getItem(LEGACY_AUTH_TOKEN_STORAGE_KEY);
  if (legacy === null) {
    return;
  }

  localStorage.removeItem(LEGACY_AUTH_TOKEN_STORAGE_KEY);
  if (!localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) && !isTokenExpired(legacy)) {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, legacy);
  }
};

/**
 * Reads the persisted token without inspecting it. Use this when you need to
 * compare what is stored now against what a request was made with.
 */
export const readRawAuthToken = (): string | null => {
  migrateLegacyToken();
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
};

/**
 * Persists a token that originated from an untrusted source (the refreshed-token
 * response header). The value is validated for JWT shape first; a malformed or
 * injected header is ignored rather than allowed to overwrite a working token.
 *
 * The header can also be stale: the browser HTTP cache stores it with the
 * response, and a later 304 revalidation hands the cached header back verbatim.
 * That replayed a week-old token over a fresh login on every sign-in, and the
 * next request got a 403. So an expired token, or one issued before the token we
 * already hold, is never allowed to replace it.
 */
export const persistAuthToken = (token: unknown): void => {
  if (!isValidRefreshedToken(token) || isTokenExpired(token)) {
    return;
  }

  const current = readRawAuthToken();
  if (current) {
    const currentIat = readTokenClaims(current)?.iat ?? 0;
    const nextIat = readTokenClaims(token)?.iat ?? 0;
    if (nextIat <= currentIat) {
      return;
    }
  }

  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

export const clearAuthToken = (): void => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  localStorage.removeItem(LEGACY_AUTH_TOKEN_STORAGE_KEY);
};

/**
 * Returns the stored token, dropping only a value that is structurally unusable.
 *
 * Expiry is deliberately NOT enforced here. Two things went wrong when it was:
 *
 * 1. The device clock is not trustworthy. A phone running ahead reads a token
 *    the server still accepts as expired and throws away a working session.
 * 2. This function is called from inside `authenticatedFetch`, so clearing here
 *    desynchronised storage from the React auth state: the state still held a
 *    token, passed its `if (!token)` guard, and the request then went out with
 *    no Authorization header at all. The server answered 401 — indistinguishable
 *    from a real rejection — and the session was wiped. That is the 401 seen in
 *    the proxy log with no matching token error on the server.
 *
 * The server is the authority on expiry; a 401/403 is what ends a session.
 */
export const readValidAuthToken = (): string | null => {
  const stored = readRawAuthToken();
  if (!stored) {
    return null;
  }

  // Not a JWT at all (truncated write, foreign value): nothing can use it.
  if (!isValidRefreshedToken(stored)) {
    clearAuthToken();
    return null;
  }

  return stored;
};
