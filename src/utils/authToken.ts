import {
  AUTH_TOKEN_STORAGE_KEY,
  LEGACY_AUTH_TOKEN_STORAGE_KEY,
} from '../components/auth/constants';

/**
 * Decodes the JWT payload and reports whether it is already past its `exp`.
 * Anything unparseable counts as expired so we never send garbage to the server.
 */
export const isTokenExpired = (token: string): boolean => {
  try {
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) {
      return true;
    }

    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(normalized)) as { exp?: number };
    return typeof exp !== 'number' || exp * 1000 <= Date.now();
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

export const persistAuthToken = (token: string): void => {
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
