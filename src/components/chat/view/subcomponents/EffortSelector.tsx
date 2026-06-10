import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, X } from 'lucide-react';

export const EFFORT_LEVELS = [
  { id: 'low',    label: 'low',    thinkPrefix: '' },
  { id: 'medium', label: 'medium', thinkPrefix: 'think' },
  { id: 'high',   label: 'high',   thinkPrefix: 'think hard' },
  { id: 'xhigh',  label: 'xhigh',  thinkPrefix: 'think harder' },
  { id: 'max',    label: 'max',    thinkPrefix: 'ultrathink' },
] as const;

export type EffortLevel = typeof EFFORT_LEVELS[number]['id'];

export const DEFAULT_EFFORT: EffortLevel = 'high';

export function getEffortPrefix(level: EffortLevel): string {
  return EFFORT_LEVELS.find(e => e.id === level)?.thinkPrefix ?? '';
}

type EffortSelectorProps = {
  effortLevel: EffortLevel;
  onEffortChange: (level: EffortLevel) => void;
};

export function EffortSelector({ effortLevel, onEffortChange }: EffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  const closeDropdown = useCallback(() => setIsOpen(false), []);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown || typeof window === 'undefined') return;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = window.innerWidth < 640 ? 12 : 16;
    const spacing = 8;
    const width = Math.min(window.innerWidth - viewportPadding * 2, 280);
    let left = triggerRect.left + triggerRect.width / 2 - width / 2;
    left = Math.max(viewportPadding, Math.min(left, window.innerWidth - width - viewportPadding));

    const measuredHeight = dropdown.offsetHeight || 0;
    const spaceBelow = window.innerHeight - triggerRect.bottom - spacing - viewportPadding;
    const spaceAbove = triggerRect.top - spacing - viewportPadding;
    const openBelow = spaceBelow >= Math.min(measuredHeight || 160, 160) || spaceBelow >= spaceAbove;
    const availableHeight = Math.min(window.innerHeight - viewportPadding * 2, Math.max(100, openBelow ? spaceBelow : spaceAbove));
    const panelHeight = Math.min(measuredHeight || availableHeight, availableHeight);
    const top = openBelow
      ? Math.min(triggerRect.bottom + spacing, window.innerHeight - viewportPadding - panelHeight)
      : Math.max(viewportPadding, triggerRect.top - spacing - panelHeight);

    setDropdownStyle({ position: 'fixed', top, left, width, maxHeight: availableHeight, zIndex: 80 });
  }, []);

  useEffect(() => {
    if (!isOpen) { setDropdownStyle(null); return; }
    const rafId = window.requestAnimationFrame(updateDropdownPosition);
    window.addEventListener('resize', updateDropdownPosition);
    window.addEventListener('scroll', updateDropdownPosition, true);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updateDropdownPosition);
      window.removeEventListener('scroll', updateDropdownPosition, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (containerRef.current?.contains(t) || dropdownRef.current?.contains(t)) return;
      closeDropdown();
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDropdown(); };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, closeDropdown]);

  const currentIdx = EFFORT_LEVELS.findIndex(e => e.id === effortLevel);
  const isDefault = effortLevel === DEFAULT_EFFORT;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(v => !v)}
        className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition-all duration-150 ${
          isDefault
            ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
            : effortLevel === 'max'
              ? 'border-red-300/60 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-600/40 dark:bg-red-900/15 dark:text-red-300 dark:hover:bg-red-900/25'
              : effortLevel === 'xhigh'
                ? 'border-purple-300/60 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:border-purple-600/40 dark:bg-purple-900/15 dark:text-purple-300 dark:hover:bg-purple-900/25'
                : effortLevel === 'low' || effortLevel === 'medium'
                  ? 'border-sky-300/60 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-600/40 dark:bg-sky-900/15 dark:text-sky-300 dark:hover:bg-sky-900/25'
                  : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
        title={`Effort: ${effortLevel}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden whitespace-nowrap sm:inline">{effortLevel}</span>
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={dropdownStyle || { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
          className="overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
          role="listbox"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <h3 className="text-xs font-semibold text-foreground">Effort</h3>
            <button
              type="button"
              onClick={closeDropdown}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="p-3">
            <div className="mb-1.5 flex justify-between px-0.5 text-[10px] text-muted-foreground">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div className="relative mb-1">
              <div className="flex h-3 items-end px-[9%]">
                <div
                  className="h-2 w-px bg-foreground/70 transition-all duration-150"
                  style={{ marginLeft: `${(currentIdx / 4) * 100}%`, transform: 'translateX(-50%)' }}
                />
              </div>
            </div>
            <div className="flex rounded-lg border border-border bg-muted/30 p-0.5 gap-0.5">
              {EFFORT_LEVELS.map((level) => (
                <button
                  key={level.id}
                  type="button"
                  role="option"
                  aria-selected={level.id === effortLevel}
                  onClick={() => {
                    onEffortChange(level.id);
                    closeDropdown();
                  }}
                  className={`flex-1 rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                    level.id === effortLevel
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {level.label}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
