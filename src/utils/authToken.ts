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
export const isTokenExpired = (token: string): boolean => {
  try {
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) {
      return true;
    }

    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(normalized)) as { exp?: number };
    return typeof exp !== 'number' || exp * 1000 + TOKEN_EXPIRY_SKEW_MS <= Date.now();
  } catch {
    return true;
  }
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
 */
export const persistAuthToken = (token: unknown): void => {
  if (!isValidRefreshedToken(token)) {
    return;
  }
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

export const clearAuthToken = (): void => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  localStorage.removeItem(LEGACY_AUTH_TOKEN_STORAGE_KEY);
};

/**
 * Returns the stored token only while it is still valid, dropping it otherwise.
 *
 * This is the single gate every outgoing request goes through. An expired token
 * left in localStorage is answered with 403 by the server, and a 403 on
 * /api/auth/user is treated as "this session is dead" — which used to wipe a
 * session that had just been established by a successful login.
 */
export const readValidAuthToken = (): string | null => {
  const stored = readRawAuthToken();
  if (!stored) {
    return null;
  }

  if (isTokenExpired(stored)) {
    clearAuthToken();
    return null;
  }

  return stored;
};
