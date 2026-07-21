// Versioned key: pre-fix code (an old tab or an installed PWA still running the
// previous bundle) reads and *clears* 'auth-token' whenever its stale token gets
// a 403. Moving to a key that code has never heard of makes the new session
// unreachable to it. The legacy key is migrated once, then deleted.
export const AUTH_TOKEN_STORAGE_KEY = 'cloudcli-auth-token';
export const LEGACY_AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
} as const;
