/**
 * Whether the primary input is a touch screen, i.e. text is typed on an
 * on-screen keyboard.
 *
 * Deliberately not a viewport-width check: a narrow desktop window still has a
 * hardware keyboard, and a tablet in landscape is wider than any phone
 * breakpoint. `pointer: coarse` asks the question we actually care about.
 *
 * Read at event time rather than stored in state — a device does not grow a
 * hardware keyboard mid-keystroke, and this keeps callers free of a re-render.
 */
export const hasSoftKeyboard = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches;
};
