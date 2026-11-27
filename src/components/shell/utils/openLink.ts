/**
 * Opening links from the terminal in a new browser tab.
 *
 * A click on a link the Claude CLI printed reaches two handlers: the
 * terminal's own link support here, and the CLI (it reads mouse clicks),
 * which runs its BROWSER script and the server forwards the link to this
 * page. Whichever comes first opens the link; the other one within a few
 * seconds is dropped, so the link opens once.
 */

const RECENT_MS = 4000;
const recent = new Map<string, number>();

/** An address safe to open: http(s) only. */
export function openableLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Notes that `url` is being handled now. False when it already was within
 * the last few seconds (the other handler got there first).
 */
export function claimLink(url: string, now = Date.now()): boolean {
  for (const [key, at] of recent) {
    if (now - at > RECENT_MS) {
      recent.delete(key);
    }
  }
  const last = recent.get(url);
  if (last !== undefined && now - last <= RECENT_MS) {
    return false;
  }
  recent.set(url, now);
  return true;
}

export function resetOpenedLinksForTests(): void {
  recent.clear();
}

/**
 * Opens `url` in a new tab without giving it a handle on this page. False when
 * the browser blocked the new tab (no recent click on the page).
 */
export function openInNewTab(url: string, open: typeof window.open = window.open.bind(window)): boolean {
  const opened = open();
  if (!opened) {
    return false;
  }
  try {
    opened.opener = null;
  } catch {
    // Some browsers do not allow it; the tab still opens.
  }
  opened.location.href = url;
  return true;
}

type Press = { url: string; askFirst: boolean; x: number; y: number };
type PointerLike = { button: number; clientX: number; clientY: number };

/**
 * Clicks on terminal links, decided from the press rather than the release.
 *
 * xterm.js activates a link when the button goes up over the link it
 * remembered on hover. A full-screen CLI that reads the mouse (Claude) often
 * redraws the screen as soon as the button goes down, and xterm.js then drops
 * the remembered link, so most clicks did nothing. Here the link under the
 * pointer is taken when the button goes down, and opened when it comes up
 * without the pointer having moved (a drag selects text instead).
 */
export function createLinkClickTracker(activate: (url: string, askFirst: boolean) => void) {
  let hovered: { url: string; askFirst: boolean } | null = null;
  let pressed: Press | null = null;
  return {
    hover(url: string, askFirst: boolean) {
      hovered = { url, askFirst };
    },
    leave(url: string) {
      if (hovered?.url === url) {
        hovered = null;
      }
    },
    down(event: PointerLike) {
      pressed = event.button === 0 && hovered
        ? { ...hovered, x: event.clientX, y: event.clientY }
        : null;
    },
    up(event: PointerLike) {
      const press = pressed;
      pressed = null;
      if (!press || event.button !== 0) {
        return;
      }
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
        return;
      }
      activate(press.url, press.askFirst);
    },
  };
}
