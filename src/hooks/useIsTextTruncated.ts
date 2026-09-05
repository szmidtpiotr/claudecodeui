import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reports whether an element's text is currently clipped by CSS truncation.
 *
 * Used to keep "show the full value" affordances (tooltips) off elements that
 * already display their whole text, where the tooltip would be pure noise.
 *
 * The observer is attached through a callback ref rather than an effect,
 * because a consumer may swap the element for a new node in response to this
 * hook's own result — a tooltip wrapper that only renders once the text is
 * truncated does exactly that. An effect would keep observing the detached
 * node and stop reacting to later resizes.
 */
export function useIsTextTruncated<TElement extends HTMLElement>(text: string) {
  const [isTruncated, setIsTruncated] = useState(false);
  const elementRef = useRef<TElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    // A sub-pixel layout can report a fractional difference for text that
    // visually fits, so only a real overflow counts.
    setIsTruncated(element.scrollWidth - element.clientWidth > 1);
  }, []);

  const setElement = useCallback(
    (element: TElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      elementRef.current = element;

      if (!element) {
        return;
      }

      measure();

      if (typeof ResizeObserver !== 'undefined') {
        observerRef.current = new ResizeObserver(measure);
        observerRef.current.observe(element);
      }
    },
    [measure],
  );

  // The same element can stop fitting when its text changes.
  useEffect(() => {
    measure();
  }, [measure, text]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { elementRef: setElement, isTruncated };
}
