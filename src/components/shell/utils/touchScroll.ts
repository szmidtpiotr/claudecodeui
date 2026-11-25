import type { Terminal } from '@xterm/xterm';

// Finger travel before a touch counts as a scroll and not a tap.
const SCROLL_START_THRESHOLD_PX = 8;
// Programs that scroll themselves (tmux history, a full-screen CLI) move a few
// lines per wheel notch; send one notch per this many rows of finger travel so
// the text roughly follows the finger.
const ROWS_PER_WHEEL_NOTCH = 3;
const FALLBACK_ROW_HEIGHT_PX = 17;
const INERTIA_MIN_SPEED_PX_PER_MS = 0.05;
const INERTIA_FRICTION_PER_FRAME = 0.95;

/**
 * How many whole steps `accumulatedPx` of finger travel amounts to, and what is
 * left over for the next move. Positive = finger moved down = older content.
 */
export function consumeScrollSteps(
  accumulatedPx: number,
  stepPx: number,
): { steps: number; remainderPx: number } {
  if (!(stepPx > 0)) {
    return { steps: 0, remainderPx: 0 };
  }

  const steps = Math.trunc(accumulatedPx / stepPx);
  return { steps, remainderPx: accumulatedPx - steps * stepPx };
}

/**
 * One-finger vertical scrolling for the terminal on touch screens.
 *
 * xterm.js only scrolls its own scrollback on touch. When the program owns the
 * screen (tmux, a full-screen CLI) there is no scrollback to move, and a swipe
 * did nothing. Here a swipe becomes what a mouse wheel would be: synthetic
 * wheel events that xterm.js encodes for the program, or a plain scrollback
 * move when the program is not handling scrolling.
 */
export function attachTouchScroll(container: HTMLElement, getTerminal: () => Terminal | null): () => void {
  let tracking = false;
  let scrolling = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastMoveAt = 0;
  let velocity = 0; // px per ms, positive = finger moving down
  let pendingPx = 0;
  let inertiaFrame = 0;

  const rowHeight = (): number => {
    const terminal = getTerminal();
    const screen = terminal?.element?.querySelector('.xterm-screen');
    if (!terminal || !screen || terminal.rows === 0) {
      return FALLBACK_ROW_HEIGHT_PX;
    }

    const height = screen.clientHeight / terminal.rows;
    return height > 4 ? height : FALLBACK_ROW_HEIGHT_PX;
  };

  const scrollBy = (deltaPx: number) => {
    const terminal = getTerminal();
    if (!terminal) {
      return;
    }

    const programScrolls =
      terminal.modes.mouseTrackingMode !== 'none' || terminal.buffer.active.type === 'alternate';
    const stepPx = rowHeight() * (programScrolls ? ROWS_PER_WHEEL_NOTCH : 1);

    pendingPx += deltaPx;
    const { steps, remainderPx } = consumeScrollSteps(pendingPx, stepPx);
    pendingPx = remainderPx;
    if (steps === 0) {
      return;
    }

    if (!programScrolls) {
      terminal.scrollLines(-steps);
      return;
    }

    const target = terminal.element?.querySelector('.xterm-screen') ?? terminal.element;
    if (!target) {
      return;
    }

    for (let i = 0; i < Math.abs(steps); i++) {
      target.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: steps > 0 ? -1 : 1,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: lastX,
          clientY: lastY,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };

  const stopInertia = () => {
    if (inertiaFrame) {
      window.cancelAnimationFrame(inertiaFrame);
      inertiaFrame = 0;
    }
  };

  const runInertia = () => {
    let previous = performance.now();

    const step = (now: number) => {
      const elapsed = Math.min(now - previous, 50);
      previous = now;
      velocity *= Math.pow(INERTIA_FRICTION_PER_FRAME, elapsed / 16);

      if (Math.abs(velocity) < INERTIA_MIN_SPEED_PX_PER_MS) {
        inertiaFrame = 0;
        return;
      }

      scrollBy(velocity * elapsed);
      inertiaFrame = window.requestAnimationFrame(step);
    };

    inertiaFrame = window.requestAnimationFrame(step);
  };

  const handleTouchStart = (event: TouchEvent) => {
    stopInertia();
    scrolling = false;
    tracking = event.touches.length === 1;
    if (!tracking) {
      return;
    }

    const touch = event.touches[0];
    startX = lastX = touch.clientX;
    startY = lastY = touch.clientY;
    lastMoveAt = performance.now();
    velocity = 0;
    pendingPx = 0;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (!tracking || event.touches.length !== 1) {
      tracking = false;
      return;
    }

    const touch = event.touches[0];

    if (!scrolling) {
      const travelX = Math.abs(touch.clientX - startX);
      const travelY = Math.abs(touch.clientY - startY);
      if (travelY < SCROLL_START_THRESHOLD_PX) {
        return;
      }
      if (travelX > travelY) {
        tracking = false; // a sideways swipe is not ours
        return;
      }
      scrolling = true;
      lastY = touch.clientY;
      lastMoveAt = performance.now();
    }

    // Ours from here on: no page scroll / pull-to-refresh, and xterm.js's own
    // touch scrolling must not move the scrollback a second time.
    event.preventDefault();
    event.stopPropagation();

    const now = performance.now();
    const deltaY = touch.clientY - lastY;
    const elapsed = Math.max(now - lastMoveAt, 1);
    velocity = 0.7 * (deltaY / elapsed) + 0.3 * velocity;
    lastX = touch.clientX;
    lastY = touch.clientY;
    lastMoveAt = now;

    scrollBy(deltaY);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (!scrolling) {
      tracking = false;
      return;
    }

    event.stopPropagation();
    tracking = false;
    scrolling = false;

    // A finger resting before lift-off means "stop here", not a fling.
    if (performance.now() - lastMoveAt < 80 && Math.abs(velocity) > INERTIA_MIN_SPEED_PX_PER_MS) {
      runInertia();
    }
  };

  container.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
  container.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  container.addEventListener('touchend', handleTouchEnd, { capture: true });
  container.addEventListener('touchcancel', handleTouchEnd, { capture: true });

  return () => {
    stopInertia();
    container.removeEventListener('touchstart', handleTouchStart, { capture: true });
    container.removeEventListener('touchmove', handleTouchMove, { capture: true });
    container.removeEventListener('touchend', handleTouchEnd, { capture: true });
    container.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
  };
}
