# Design: `/btw` Mid-Run Steering

**Date:** 2026-06-19  
**Status:** Approved for implementation  
**Branch:** feat/btw-steering (to branch from `feat/per-session-thinking-model`)

---

## Problem

Claude Code CLI supports `/btw <text>` — injecting a "by the way" message into an actively-running agent turn without interrupting it. The webui has no equivalent: messages typed while the agent is busy are queued until the turn completes (via `useQueuedPrompt.ts`). There is no way to steer the agent mid-run.

---

## Root Cause

`server/claude-sdk.js:644` calls:

```js
queryInstance = query({ prompt: finalCommand, options: sdkOptions });
```

`prompt` is a plain string → **one-shot mode**. The SDK's streaming-input mode (required for mid-run injection) is only activated when `prompt` is an `AsyncIterable<SDKUserMessage>`. Control requests like `priority: 'now'` injection and `interrupt()` only work in streaming-input mode.

---

## Solution: Per-Turn Push Channel (Approach 1)

Switch every turn to streaming-input mode by replacing the string `prompt` with a push-channel async iterable. The initial user message is pushed into the channel immediately. Additional `/btw` messages are pushed by a new WS handler while the generator runs. The channel is closed when the `result` message arrives (or on abort).

No session lifecycle changes. No multi-turn persistent stream. One push channel per turn, discarded on completion.

---

## Architecture

### Push Channel

New helper `createPushChannel()` in `server/claude-sdk.js`:

```js
function createPushChannel() {
  const queue = [];
  let waitResolve = null;
  let closed = false;

  return {
    push(message) {
      if (closed) return;
      queue.push(message);
      if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
    },
    close() {
      if (closed) return;
      closed = true;
      if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
    },
    get isClosed() { return closed; },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0 && !closed) {
              await new Promise(r => { waitResolve = r; });
            }
            if (queue.length > 0) return { value: queue.shift(), done: false };
            return { value: undefined, done: true };
          }
        };
      }
    }
  };
}
```

### Turn Lifecycle (modified)

```
BEFORE:
  queryInstance = query({ prompt: finalCommand, options })

AFTER:
  const channel = createPushChannel();
  channel.push({
    type: 'user',
    message: { role: 'user', content: finalCommand },
    parent_tool_use_id: null,
    shouldQuery: true
  });
  queryInstance = query({ prompt: channel.iterable, options });
  // store channel in session:
  addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, channel);

  for await (const message of queryInstance) {
    if (message.type === 'result') channel.close();
    // ... existing handling
  }
```

### Session Store Change

`addSession()` gains a `pushChannel` parameter. Session object becomes:
```js
{ instance: queryInstance, pushChannel, tempImagePaths, tempDir, ws }
```

Abort path (`abortClaudeSDKSession`) calls `session.pushChannel?.close()` after `session.instance.interrupt()`.

### New Export: `injectBtwMessage(sessionId, content)`

```js
export function injectBtwMessage(sessionId, content) {
  const session = getSession(sessionId);
  if (!session?.pushChannel || session.pushChannel.isClosed) {
    return { ok: false, reason: 'no_active_turn' };
  }
  session.pushChannel.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    priority: 'now',
    shouldQuery: true
  });
  return { ok: true };
}
```

### WebSocket Handler (`chat-websocket.service.ts`)

New message type `'btw-inject'`:

```ts
case 'btw-inject': {
  const { sessionId, content } = parsedMessage;
  const result = dependencies.injectBtwMessage(sessionId, content);
  if (!result.ok) {
    ws.send(createNormalizedMessage({
      kind: 'error',
      error: 'No active turn to inject into',
      sessionId
    }));
  }
  break;
}
```

`dependencies` object in `server/index.js` gains `injectBtwMessage` alongside existing `abortClaudeSDKSession`.

### Slash Command Registration (`server/routes/commands.js`)

```js
{
  name: '/btw',
  description: 'Inject a steering message into the running agent turn',
  namespace: 'btw',
  type: 'btw',
  metadata: { type: 'btw' }
}
```

Type `'btw'` (not `'cli'`) so selection inserts `/btw ` into composer — same as skills — rather than passing directly to SDK as a raw command.

### Frontend Submit Handler (`useChatComposerState.ts`)

In `handleSubmit`, prepend a new branch **before** the existing `isLoading → enqueuePrompt` path:

```ts
const BTW_RE = /^\/btw\s+(.+)/s;
const btwMatch = input.trim().match(BTW_RE);

if (btwMatch) {
  if (isLoading && sessionId) {
    sendMessage({ type: 'btw-inject', sessionId, content: btwMatch[1].trim() });
    setInput('');
    // show steering indicator (see below)
  } else {
    // show warning: no active turn
    showToast('No active turn — /btw only works while agent is running');
  }
  return;
}
// ... existing: if (isLoading) → enqueuePrompt …
```

### Visual Indicator (`ChatComposer.tsx`)

When `btw-inject` is sent, display a transient inline chip below the composer (reuses existing queued-prompt banner pattern):

```
↪ Steering message sent
```

Dismissed after 3 seconds or when turn completes. No separate message bubble — this is not a conversation turn, it's a control signal.

---

## Data Flow

```
User types "/btw check that file first" → Submit
  → handleSubmit detects /btw, isLoading=true
  → WS send { type:'btw-inject', sessionId, content:'check that file first' }

server/chat-websocket.service.ts
  → injectBtwMessage(sessionId, content)

server/claude-sdk.js
  → session.pushChannel.push({
      type:'user', message:{role:'user', content},
      parent_tool_use_id:null, priority:'now', shouldQuery:true
    })

SDK async generator
  → receives SDKUserMessage with priority:'now'
  → agent considers it immediately mid-turn
  → continues streaming output (no interruption)

Frontend
  → receives continued stream of assistant messages
  → brief "Steering message sent" chip clears after 3s
```

---

## Error Cases

| Scenario | Behavior |
|---|---|
| `/btw` sent after `result` arrives but before `isLoading` clears | `pushChannel.isClosed === true` → WS error → frontend toast "No active turn" |
| `/btw` with no active session | `getSession()` returns null → same error path |
| `/btw` typed while NOT loading | Frontend catches before WS send → warning toast |
| Multiple `/btw` in quick succession | Queue drains in order, all injected |
| Abort while `/btw` pending in queue | `abort` closes channel → generator ends → pending items dropped |
| `/btw` with empty content | Frontend rejects before WS send: `btwMatch[1].trim()` falsy → no-op |

---

## Files Changed

| File | Change |
|---|---|
| `server/claude-sdk.js` | `createPushChannel()`, modify `queryClaudeSDK()`, add `injectBtwMessage()`, patch `abortClaudeSDKSession()`, patch `addSession()` |
| `server/modules/websocket/services/chat-websocket.service.ts` | Handle `'btw-inject'` WS type, wire `injectBtwMessage` dependency |
| `server/index.js` | Add `injectBtwMessage` to dependencies object |
| `server/routes/commands.js` | Add `/btw` to slash command list with type `'btw'` |
| `src/components/chat/hooks/useSlashCommands.ts` | Add `isBtwCommand` check so selecting `/btw` inserts into composer (not executes) |
| `src/components/chat/hooks/useChatComposerState.ts` | `/btw` branch in `handleSubmit`, steering send logic |
| `src/components/chat/view/subcomponents/ChatComposer.tsx` | "Steering message sent" transient chip |

---

## Out of Scope

- Multi-turn persistent streaming session (Approach 2) — YAGNI
- `priority: 'next'` or `priority: 'later'` variants — not requested
- `/btw` for non-Claude providers — Gemini/OpenCode/Cursor have different execution models; excluded for now
- Steering history in chat transcript — `/btw` is a control signal, not a conversation turn
