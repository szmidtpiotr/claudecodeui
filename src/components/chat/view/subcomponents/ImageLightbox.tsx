import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;
const HINT_STORAGE_KEY = 'lightbox-gesture-hint-shown';

export default function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [controlsVisible, setControlsVisible] = useState(true);
  const [zoomPill, setZoomPill] = useState<string | null>(null);
  const [hintVisible, setHintVisible] = useState(false);

  // Touch / drag state
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const touchMoved = useRef(false);
  const lastPinchDist = useRef<number | null>(null);
  const lastTapTime = useRef(0);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const overlayRef = useRef<HTMLDivElement>(null);

  const controlsTimer = useRef<ReturnType<typeof setTimeout>>();
  const zoomPillTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

  // ── Zoom pill ───────────────────────────────────────────────────────────────
  const flashZoomPill = useCallback((z: number) => {
    setZoomPill(`${Math.round(z * 100)}%`);
    clearTimeout(zoomPillTimer.current);
    zoomPillTimer.current = setTimeout(() => setZoomPill(null), 1100);
  }, []);

  // ── Controls auto-hide ──────────────────────────────────────────────────────
  const scheduleHide = useCallback(() => {
    clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 2800);
  }, []);

  const revealControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    scheduleHide();
    if (!localStorage.getItem(HINT_STORAGE_KEY)) {
      localStorage.setItem(HINT_STORAGE_KEY, '1');
      setHintVisible(true);
      setTimeout(() => setHintVisible(false), 2800);
    }
    return () => {
      clearTimeout(controlsTimer.current);
      clearTimeout(zoomPillTimer.current);
    };
  }, [scheduleHide]);

  // ── ESC ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // ── Wheel zoom ──────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    setZoom(z => {
      const next = clamp(z * factor);
      flashZoomPill(next);
      return next;
    });
    revealControls();
  }, [flashZoomPill, revealControls]);

  // ── Mouse drag ───────────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    isDragging.current = true;
    touchMoved.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    panStart.current = { ...panRef.current };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) touchMoved.current = true;
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy });
  }, []);

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (!touchMoved.current && e.target === overlayRef.current) onClose();
    isDragging.current = false;
    touchMoved.current = false;
  }, [onClose]);

  // ── Touch ────────────────────────────────────────────────────────────────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    revealControls();
    if (e.touches.length === 2) {
      isDragging.current = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist.current = Math.hypot(dx, dy);
    } else if (e.touches.length === 1) {
      // Double-tap detection
      const now = Date.now();
      if (now - lastTapTime.current < 280) {
        e.preventDefault();
        const z = zoomRef.current;
        if (z > 1.1) {
          setZoom(1); setPan({ x: 0, y: 0 }); flashZoomPill(1);
        } else {
          const next = 2.5;
          setZoom(next); flashZoomPill(next);
        }
        lastTapTime.current = 0;
        return;
      }
      lastTapTime.current = now;
      isDragging.current = true;
      touchMoved.current = false;
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      panStart.current = { ...panRef.current };
    }
  }, [revealControls, flashZoomPill]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (lastPinchDist.current !== null) {
        const ratio = dist / lastPinchDist.current;
        setZoom(z => {
          const next = clamp(z * ratio);
          flashZoomPill(next);
          return next;
        });
      }
      lastPinchDist.current = dist;
    } else if (e.touches.length === 1 && isDragging.current) {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) touchMoved.current = true;
      setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy });
    }
  }, [flashZoomPill]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) lastPinchDist.current = null;
    if (e.touches.length === 0) {
      if (!touchMoved.current) {
        // Single tap toggles controls
        setControlsVisible(v => {
          if (!v) scheduleHide();
          return !v;
        });
      }
      isDragging.current = false;
      touchMoved.current = false;
    }
  }, [scheduleHide]);

  const controlsCls = `transition-opacity duration-300 ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.94)' }}
      onMouseUp={onMouseUp}
    >
      {/* ── Close button ─────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={onClose}
        className={`absolute right-4 top-4 z-20 flex h-11 w-11 items-center justify-center rounded-full ${controlsCls}`}
        style={{ background: 'rgba(255,255,255,0.13)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        title="Close"
        aria-label="Close image"
      >
        <X className="h-5 w-5 text-white" strokeWidth={2} />
      </button>

      {/* ── Bottom controls ──────────────────────────────────────────────────── */}
      <div className={`absolute bottom-8 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 ${controlsCls}`}>
        <button
          type="button"
          onClick={() => { const z = clamp(zoomRef.current * 0.75); setZoom(z); flashZoomPill(z); revealControls(); }}
          className="flex h-10 w-10 items-center justify-center rounded-full text-white text-xl font-light select-none"
          style={{ background: 'rgba(255,255,255,0.13)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
          aria-label="Zoom out"
        >−</button>

        <button
          type="button"
          onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); flashZoomPill(1); revealControls(); }}
          className="h-10 rounded-full px-4 text-white text-xs font-medium tracking-wide select-none"
          style={{ background: 'rgba(255,255,255,0.13)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
        >Reset</button>

        <button
          type="button"
          onClick={() => { const z = clamp(zoomRef.current * 1.33); setZoom(z); flashZoomPill(z); revealControls(); }}
          className="flex h-10 w-10 items-center justify-center rounded-full text-white text-xl font-light select-none"
          style={{ background: 'rgba(255,255,255,0.13)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
          aria-label="Zoom in"
        >+</button>
      </div>

      {/* ── Zoom pill (fades automatically) ─────────────────────────────────── */}
      <div
        className={`pointer-events-none absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-300 ${zoomPill ? 'opacity-100' : 'opacity-0'}`}
      >
        <span
          className="block rounded-xl px-4 py-2 text-2xl font-bold text-white tabular-nums"
          style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
        >
          {zoomPill ?? ''}
        </span>
      </div>

      {/* ── First-open gesture hint ──────────────────────────────────────────── */}
      <div
        className={`pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap transition-opacity duration-500 ${hintVisible ? 'opacity-100' : 'opacity-0'}`}
      >
        <p
          className="rounded-full px-4 py-2 text-xs text-white/70"
          style={{ background: 'rgba(0,0,0,0.45)' }}
        >
          Pinch · Double-tap · Drag · Tap to toggle controls
        </p>
      </div>

      {/* ── Image ────────────────────────────────────────────────────────────── */}
      <div
        className="select-none"
        style={{
          cursor: isDragging.current ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
          touchAction: 'none',
        }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={() => { isDragging.current = false; }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
            maxWidth: '92vw',
            maxHeight: '88vh',
            transition: isDragging.current ? 'none' : 'transform 0.12s ease-out',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      </div>
    </div>
  );
}
