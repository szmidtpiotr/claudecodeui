import assert from 'node:assert/strict';
import test from 'node:test';

import { readChatRunOptions } from './chatRunOptions';

const storage = (entries: Record<string, string>) => ({ getItem: (key: string) => entries[key] ?? null });

test('the conversation\'s own mode wins over the Claude default, tool settings come along', () => {
  const options = readChatRunOptions('abc', storage({
    'permissionMode-abc': 'bypassPermissions',
    'permissionMode-provider-claude': 'default',
    'claude-settings': JSON.stringify({ allowedTools: ['Bash'], skipPermissions: false }),
  }));
  assert.deepEqual(options, { permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: ['Bash'], skipPermissions: false } });
});

test('falls back to the last Claude mode; nothing stored means nothing sent', () => {
  assert.deepEqual(readChatRunOptions('abc', storage({ 'permissionMode-provider-claude': 'acceptEdits' })), { permissionMode: 'acceptEdits' });
  assert.equal(readChatRunOptions('abc', storage({})), undefined);
  assert.equal(readChatRunOptions('abc', storage({ 'permissionMode-abc': 'nonsense', 'claude-settings': '{bad' })), undefined);
});
