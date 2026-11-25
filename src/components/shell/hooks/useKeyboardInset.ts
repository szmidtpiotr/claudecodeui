import { type RefObject, useEffect, useState } from 'react';

/** Reads `env(safe-area-inset-bottom)` in pixels (the system navigation bar). */
function readSafeAreaBottom(): number {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

export type KeyboardInsetDebug = {
  inset: number;
  covered: number;
  safeBottom: number;
  viewportHeight: number;
  viewportTop: number;
  innerHeight: number;
  elementBottom: number;
  elementTop: number;
  clientHeight: number;
  outerHeight: number;
  screenHeight: number;
  scrollY: number;
  pageTop: number;
  safeNow: number;
  dpr: number;
};

/**
 * How many pixels at the bottom of `elementRef` are covered by the on-screen
 * keyboard. Mobile browsers shrink only the visual viewport when the keyboard
 * opens, so without this the last terminal rows (where a CLI keeps its prompt)
 * and the key bar sit underneath it.
 */
export function useKeyboardInset(elementRef: RefObject<HTMLElement>): {
  inset: number;
  debug: KeyboardInsetDebug | null;
} {
  const [inset, setInset] = useState(0);
  const [debug, setDebug] = useState<KeyboardInsetDebug | null>(null);

  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!viewport) {
      return undefined;
    }

    const showDebug =
      new URLSearchParams(window.location.search).has('kbdebug') ||
      import.meta.env.VITE_KB_DEBUG === '1';
    // Chrome on edge-to-edge Android shrinks the page when the keyboard opens,
    // but only down to the bottom of the screen area it draws on: the strip
    // that held the system navigation bar (24 px on a Pixel) still lies under
    // the top of the keyboard. That strip is known only while the keyboard is
    // closed, as the bottom safe area, so it is remembered from then.
    let safeBottom = 0;
    // Tallest viewport seen = keyboard closed. A much shorter one = keyboard open.
    let tallestViewport = 0;
    const timers: number[] = [];

    const measure = () => {
      const element = elementRef.current;
      if (!element) {
        return;
      }

      tallestViewport = Math.max(tallestViewport, viewport.height);
      const visibleBottom = viewport.offsetTop + viewport.height;
      const elementBottom = element.getBoundingClientRect().bottom;
      // Part of the element below the visible area (browsers that do not
      // shrink the page for the keyboard at all).
      const covered = Math.max(0, Math.round(elementBottom - visibleBottom));
      const keyboardOpen = covered > 40 || tallestViewport - viewport.height > 150;
      if (!keyboardOpen) {
        safeBottom = Math.max(safeBottom, readSafeAreaBottom());
      }

      const next = keyboardOpen ? covered + Math.round(safeBottom) : 0;
      setInset(next);
      if (showDebug) {
        setDebug({
          inset: next,
          covered,
          safeBottom,
          viewportHeight: Math.round(viewport.height),
          viewportTop: Math.round(viewport.offsetTop),
          innerHeight: window.innerHeight,
          elementBottom: Math.round(elementBottom),
          elementTop: Math.round(element.getBoundingClientRect().top),
          clientHeight: document.documentElement.clientHeight,
          outerHeight: window.outerHeight,
          screenHeight: window.screen.height,
          scrollY: Math.round(window.scrollY),
          pageTop: Math.round(viewport.pageTop),
          safeNow: readSafeAreaBottom(),
          dpr: window.devicePixelRatio,
        });
      }
    };

    // The keyboard animates in and the browser may pan the page afterwards;
    // measure again once things have settled.
    const update = () => {
      measure();
      timers.push(window.setTimeout(measure, 150), window.setTimeout(measure, 450));
    };

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();

    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [elementRef]);

  return { inset, debug };
}
