import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';

function captureLogs(run: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

test('redacts the query-string token from the connection log but still authenticates with it', () => {
  let receivedToken: string | null = null;
  const req = { url: '/ws?token=secret-jwt-value&x=1', headers: {} } as any;

  let accepted = false;
  const logs = captureLogs(() => {
    accepted = verifyWebSocketClient({ req, origin: '', secure: false } as any, {
      isPlatform: false,
      authenticateWebSocket: (token) => {
        receivedToken = token;
        return { userId: 1, username: 'u' };
      },
    });
  });

  assert.equal(accepted, true);
  assert.equal(receivedToken, 'secret-jwt-value');
  assert.ok(!logs.includes('secret-jwt-value'), 'token must not appear in logs');
  assert.ok(logs.includes('/ws?token=REDACTED&x=1'));
});
