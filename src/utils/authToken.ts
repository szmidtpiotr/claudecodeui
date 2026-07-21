import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';

/**
 * Reads the persisted token without inspecting it. Use this when you need to
 * compare what is stored now against what a request was made with.
 */
export const readRawAuthToken = (): string | null =>
  localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

export const clearAuthToken = (): void => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

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
