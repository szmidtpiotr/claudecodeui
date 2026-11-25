import { type RefObject, useEffect, useState } from 'react';

/**
 * How many pixels at the bottom of `elementRef` are covered by the on-screen
 * keyboard. Mobile browsers shrink only the visual viewport when the keyboard
 * opens, so without this the last terminal rows (where a CLI keeps its prompt)
 * sit underneath it.
 */
export function useKeyboardInset(elementRef: RefObject<HTMLElement>): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!viewport) {
      return undefined;
    }

    const update = () => {
      const element = elementRef.current;
      if (!element) {
        return;
      }

      // Measured without our own padding: the padding does not move the box.
      const visibleBottom = viewport.offsetTop + viewport.height;
      const covered = Math.round(element.getBoundingClientRect().bottom - visibleBottom);
      // Browser chrome sliding in and out changes the viewport by a few px.
      setInset(covered > 40 ? covered : 0);
    };

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    update();

    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [elementRef]);

  return inset;
}
