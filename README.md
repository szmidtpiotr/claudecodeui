<div align="center">
  <img src="public/logo.svg" alt="CloudCLI UI" width="64" height="64">
  <h1>Claude Code UI — Personal Fork</h1>
  <p>Fork of <a href="https://github.com/siteboon/claudecodeui">siteboon/claudecodeui</a> (synced to v1.33.0).<br>
  A self-hosted UI for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>, <a href="https://docs.cursor.com/en/cli/overview">Cursor CLI</a>, <a href="https://developers.openai.com/codex">Codex</a>, and <a href="https://geminicli.com/">Gemini-CLI</a>.</p>
</div>

---

## Changes in this fork

### New features

- **Whisper dictation** — mic button in chat composer records audio and transcribes via a self-hosted Whisper ASR instance (WebSocket streaming). Configure endpoint and keyboard shortcut in Settings → Voice. Default shortcut: `Ctrl+Shift+M`.
- **Queued prompts** — submit a message while a session is active; it queues and fires automatically when the current task finishes. Banner shows the queued text with a cancel button. Queue clears on project or session switch to prevent cross-session leaks.
- **Collapsible tool blocks** — tool use blocks collapse by default with a one-line summary (tool name + first line of input). Expand individually or toggle all via Quick Settings.
- **Expandable activity feed** — status pill in the toolbar opens a terminal-style scrollable feed of recent tool activity.
- **Model selector in toolbar** — current model name displayed; click to change model without opening Settings. Model list auto-updates from provider API; selection persists correctly across sessions.
- **Prompt navigation panel** — navigate between previous prompts in the current session.
- **Context usage pill** — visual indicator of token context usage in the chat toolbar.
- **Quick Settings panel** — fast access to toggles (auto-scroll, expand tools, compact summaries, image thumbnails, etc.) without opening full Settings.
- **Pinned last user message** — last user prompt shown pinned at the top of the chat view for context while scrolling.
- **Push notifications** — web push with session-aware click handling: clicking a notification opens the specific session directly. Includes cold-start URL routing with provider query param.
- **Fork conversation from any message** — GitFork button on every message clears the session and pre-fills the input with that message's content.

#### Image & media

- **Image thumbnails in chat** — user-attached images display as clickable thumbnails. Toggle via Quick Settings → `IMG on/off`.
- **Tool result image previews** — when Claude reads or writes an image file (`Read / file.png`, `Write / file.png`), a thumbnail appears inline in the tool result. Works cross-project via `/api/files/raw` endpoint.
- **Fullscreen image lightbox** — click any thumbnail to open a fullscreen viewer with:
  - Pinch-to-zoom, drag to pan (mobile)
  - Double-tap to zoom 2.5× / reset
  - Mouse wheel zoom (desktop)
  - Auto-hiding controls (tap to toggle), zoom pill indicator that fades after 1 s
  - First-open gesture hint (localStorage-gated, shown once)
  - Click outside or ESC to close
- **PNG viewer in code editor** — opening a PNG/JPG/GIF via the code editor sidebar shows an image preview instead of raw binary bytes.

#### Mobile / terminal

- **Mobile terminal keyboard bar** — Shell view shows a persistent shortcut bar above the system keyboard with: `Ctrl+C`, `Ctrl+D`, `Ctrl+L`, `Ctrl+Z`, `Esc`, `Tab`, arrows, `|`, `/`, `~`, `-`, Paste, Scroll-to-bottom. Sticky `CTRL`/`ALT` modifier buttons for custom combos. Position adapts above the soft keyboard via `visualViewport` API.

#### Unread inbox

- **Unread sessions panel** — 🔔 fourth tab in the sidebar search mode toggle. Shows sessions from all projects with new agent activity (last 7 days). Sessions are marked read on navigation; pin icon keeps them visible permanently. Badge count shown on the tab.

### UX improvements

- **Restore input on early abort** — if ESC is pressed before the agent responds, the user message is removed and input is restored for editing.
- **Message timestamps show date + time** — now shows `MM/DD HH:MM` so messages from previous days are identifiable.
- **Redesigned chat footer toolbar** — cleaner layout, better mobile spacing and touch targets.
- **`allowedHosts` via `.env`** — Vite dev server hostname allowlist configurable via `VITE_ALLOWED_HOSTS` (comma-separated). Useful for reverse-proxy setups.
- **`CLAUDE_CLI_PATH` env var** — explicit path to the Claude Code native binary. Fixes "native binary not found" when running as a systemd service where `~/.local/bin` is not in PATH.

### Bug fixes

- **Model selection not persisting** — selecting a different model reverted to the previous one because the catalog-sync effect read stale localStorage. Fixed by saving to localStorage immediately on change.
- **Triple send on mobile with images** — submitting a message with an attached image fired `handleSubmit` 3× on one tap. Fixed with `isSubmittingRef` guard.
- **Shell sessions not syncing** — messages from terminal (`claude` CLI) were not updating in the UI. Fixed: removed `isLoading` guard blocking shell session refresh; reduced Chokidar polling 6 s → 2 s.
- **Shell open created new session** — opening `claude` in terminal caused a new blank session in the sidebar instead of auto-navigating to the shell session. Fixed with `projects_updated` add-event auto-switch.
- **Stale ESC abort closure** — pressing ESC to abort used a stale `chatMessages` reference. Fixed with `chatMessagesRef`.
- **Collapsed tool block showed blank** — tool block collapse preview was empty. Now shows `toolName: first line of input`.
- **Push notification click navigation** — notifications with a sessionId now open the correct session. SW uses absolute URL + `?provider=` query param for cold-start routing.

---

## Quick Start (Self-Hosted)

Requires **Node.js v22+**.

```bash
git clone https://github.com/szmidtpiotr/claudecodeui.git
cd claudecodeui
npm install
npm run build
npm start
```

Open `http://localhost:3001`.

For development:

```bash
npm run dev
```

---

## License

GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later) — see [LICENSE](LICENSE).

Upstream project: [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) · [CloudCLI](https://cloudcli.ai)
