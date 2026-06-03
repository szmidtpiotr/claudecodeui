import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

export const NOTEBOOK_HANDLE_POSITION_KEY = 'notebookHandlePosition';
const DEFAULT_POSITION = 72;
const MIN_POSITION = 10;
const MAX_POSITION = 90;
const DRAG_THRESHOLD_PX = 5;

function clamp(v: number) {
  return Math.max(MIN_POSITION, Math.min(MAX_POSITION, v));
}

function readPosition(): number {
  try {
    const saved = localStorage.getItem(NOTEBOOK_HANDLE_POSITION_KEY);
    if (!saved) return DEFAULT_POSITION;
    const parsed = JSON.parse(saved) as { y?: unknown };
    if (typeof parsed.y === 'number' && Number.isFinite(parsed.y)) {
      return clamp(parsed.y);
    }
  } catch { /* ignore */ }
  return DEFAULT_POSITION;
}

type StartEvent = ReactMouseEvent<HTMLButtonElement> | ReactTouchEvent<HTMLButtonElement>;

export function useNotebookHandleDrag() {
  const [position, setPosition] = useState(readPosition);
  const [isDragging, setIsDragging] = useState(false);
  const [isPointerDown, setIsPointerDown] = useState(false);

  const startYRef = useRef<number | null>(null);
  const startPositionRef = useRef(position);
  const didDragRef = useRef(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(NOTEBOOK_HANDLE_POSITION_KEY, JSON.stringify({ y: position }));
  }, [position]);

  const startDrag = useCallback((e: StartEvent) => {
    e.stopPropagation();
    const clientY = 'touches' in e ? e.touches[0]?.clientY ?? null : e.clientY;
    if (clientY === null) return;
    startYRef.current = clientY;
    startPositionRef.current = position;
    didDragRef.current = false;
    setIsPointerDown(true);
    setIsDragging(false);
  }, [position]);

  useEffect(() => {
    if (!isPointerDown) return;

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientY = 'touches' in e ? e.touches[0]?.clientY ?? null : e.clientY;
      if (clientY === null || startYRef.current === null) return;

      const delta = clientY - startYRef.current;

      if (!didDragRef.current && Math.abs(delta) > DRAG_THRESHOLD_PX) {
        didDragRef.current = true;
        setIsDragging(true);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }

      if (!didDragRef.current) return;

      const pct = (delta / window.innerHeight) * 100;
      setPosition(clamp(startPositionRef.current + pct));
    };

    const onUp = () => {
      suppressClickRef.current = didDragRef.current;
      didDragRef.current = false;
      startYRef.current = null;
      setIsPointerDown(false);
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
  }, [isPointerDown]);

  const consumeSuppressedClick = useCallback((): boolean => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    isDragging,
    startDrag,
    consumeSuppressedClick,
    handleStyle: { top: `${position}%`, transform: 'translateY(-50%)' },
  };
}
