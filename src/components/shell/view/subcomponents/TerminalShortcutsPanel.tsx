import { type MutableRefObject, useCallback, useRef } from 'react';
import {
  Clipboard,
  ArrowDownToLine,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Camera,
  Images,
  Loader,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Terminal } from '@xterm/xterm';

import { sendSocketMessage } from '../../utils/socket';
import { applyStickyModifiers, type StickyModifiers } from '../../utils/modifiers';

type Shortcut =
  | { type: 'key'; id: string; label: string; sequence: string; accent?: boolean }
  | { type: 'modifier'; id: string; label: string; modifier: 'ctrl' | 'alt' }
  | { type: 'arrow'; id: string; sequence: string; icon: 'up' | 'down' | 'left' | 'right' };

// Ordered by how often a CLI agent needs them on a phone: leftmost keys are
// reachable without scrolling the bar.
const MOBILE_KEYS: Shortcut[] = [
  { type: 'key', id: 'esc', label: 'Esc', sequence: '\x1b' },
  { type: 'key', id: 'shift-tab', label: '⇧Tab', sequence: '\x1b[Z' },
  { type: 'key', id: 'tab', label: 'Tab', sequence: '\t' },
  { type: 'arrow', id: 'arrow-up', sequence: '\x1b[A', icon: 'up' },
  { type: 'arrow', id: 'arrow-down', sequence: '\x1b[B', icon: 'down' },
  { type: 'arrow', id: 'arrow-left', sequence: '\x1b[D', icon: 'left' },
  { type: 'arrow', id: 'arrow-right', sequence: '\x1b[C', icon: 'right' },
  { type: 'key', id: 'enter', label: '⏎', sequence: '\r' },
  // Ctrl+J: a line break inside the prompt, where Enter would send it.
  { type: 'key', id: 'newline', label: '⇧⏎', sequence: '\n' },
  { type: 'key', id: 'ctrl-c', label: 'Ctrl+C', sequence: '\x03', accent: true },
  // Sticky modifiers: apply to the next key, from this bar or the keyboard.
  { type: 'modifier', id: 'ctrl', label: 'CTRL', modifier: 'ctrl' },
  { type: 'modifier', id: 'alt', label: 'ALT', modifier: 'alt' },
  // Characters buried two layers deep on a phone keyboard
  { type: 'key', id: 'slash', label: '/', sequence: '/' },
  { type: 'key', id: 'at', label: '@', sequence: '@' },
  { type: 'key', id: 'dash', label: '-', sequence: '-' },
  { type: 'key', id: 'underscore', label: '_', sequence: '_' },
  { type: 'key', id: 'pipe', label: '|', sequence: '|' },
  { type: 'key', id: 'tilde', label: '~', sequence: '~' },
  { type: 'key', id: 'backslash', label: '\\', sequence: '\\' },
  { type: 'key', id: 'ctrl-d', label: 'Ctrl+D', sequence: '\x04', accent: true },
  { type: 'key', id: 'ctrl-l', label: 'Ctrl+L', sequence: '\x0c', accent: true },
  { type: 'key', id: 'ctrl-z', label: 'Ctrl+Z', sequence: '\x1a', accent: true },
];

const ARROW_ICONS = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
} as const;

type TerminalShortcutsPanelProps = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  isConnected: boolean;
  modifiers: StickyModifiers;
  onModifiersChange: (next: StickyModifiers) => void;
  /** Omitted where there is no project to save images into. */
  onImageFiles?: (files: File[]) => void;
  isUploadingImages?: boolean;
  /** Pastes the clipboard (text or image) into the terminal. */
  onPaste: () => void;
};

const preventFocusSteal = (e: React.PointerEvent) => e.preventDefault();

const KEY_BASE =
  'flex h-9 min-w-9 shrink-0 items-center justify-center rounded-md border px-2.5 text-sm font-medium transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40';
const KEY_BTN = `${KEY_BASE} border-gray-600 bg-gray-700 text-gray-100 active:border-blue-600 active:bg-blue-600 active:text-white`;
const KEY_BTN_ACCENT = `${KEY_BASE} border-orange-700/60 bg-orange-900/40 text-orange-200 active:bg-orange-600 active:text-white`;
const KEY_BTN_ACTIVE = `${KEY_BASE} border-blue-500 bg-blue-600 text-white`;

export default function TerminalShortcutsPanel({
  wsRef,
  terminalRef,
  isConnected,
  modifiers,
  onModifiersChange,
  onImageFiles,
  isUploadingImages = false,
  onPaste,
}: TerminalShortcutsPanelProps) {
  const { t } = useTranslation('settings');
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const sendInput = useCallback(
    (data: string) => {
      sendSocketMessage(wsRef.current, { type: 'input', data });
    },
    [wsRef],
  );

  const scrollToBottom = useCallback(() => {
    terminalRef.current?.scrollToBottom();
    // History kept by tmux is left through the server, not through xterm.js.
    sendSocketMessage(wsRef.current, { type: 'scroll-bottom' });
  }, [terminalRef, wsRef]);

  const handleKeyPress = useCallback(
    (seq: string) => {
      sendInput(applyStickyModifiers(seq, modifiers));
      if (modifiers.ctrl || modifiers.alt) {
        onModifiersChange({ ctrl: false, alt: false });
      }
    },
    [modifiers, onModifiersChange, sendInput],
  );

  const handleFileInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so the same file can be picked again.
    event.target.value = '';
    if (files.length > 0) {
      onImageFiles?.(files);
    }
  };

  const imagesLabel = t('terminalShortcuts.attachImage', { defaultValue: 'Attach image' });
  const cameraLabel = t('terminalShortcuts.takePhoto', { defaultValue: 'Take a photo' });
  const pasteLabel = t('terminalShortcuts.paste', { defaultValue: 'Paste' });

  return (
    <div className="shrink-0 px-2 pb-1 md:hidden">
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-gray-700/80 bg-gray-900/95 px-1.5 py-1.5 shadow-lg [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {onImageFiles && (
          <>
            <button
              type="button"
              onPointerDown={preventFocusSteal}
              onClick={() => galleryInputRef.current?.click()}
              disabled={!isConnected || isUploadingImages}
              className={KEY_BTN}
              title={imagesLabel}
              aria-label={imagesLabel}
            >
              {isUploadingImages ? <Loader className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onPointerDown={preventFocusSteal}
              onClick={() => cameraInputRef.current?.click()}
              disabled={!isConnected || isUploadingImages}
              className={KEY_BTN}
              title={cameraLabel}
              aria-label={cameraLabel}
            >
              <Camera className="h-4 w-4" />
            </button>
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleFileInput}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileInput}
            />
          </>
        )}

        <button
          type="button"
          onPointerDown={preventFocusSteal}
          onClick={onPaste}
          disabled={!isConnected}
          className={KEY_BTN}
          title={pasteLabel}
          aria-label={pasteLabel}
        >
          <Clipboard className="h-4 w-4" />
        </button>

        {MOBILE_KEYS.map((key) => {
          if (key.type === 'modifier') {
            const isActive = modifiers[key.modifier];
            return (
              <button
                type="button"
                key={key.id}
                onPointerDown={preventFocusSteal}
                onClick={() => onModifiersChange({ ...modifiers, [key.modifier]: !isActive })}
                disabled={!isConnected}
                aria-pressed={isActive}
                className={isActive ? KEY_BTN_ACTIVE : KEY_BTN}
              >
                {key.label}
              </button>
            );
          }

          if (key.type === 'arrow') {
            const Icon = ARROW_ICONS[key.icon];
            return (
              <button
                type="button"
                key={key.id}
                onPointerDown={preventFocusSteal}
                onClick={() => sendInput(key.sequence)}
                disabled={!isConnected}
                className={KEY_BTN}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          }

          return (
            <button
              type="button"
              key={key.id}
              onPointerDown={preventFocusSteal}
              onClick={() => handleKeyPress(key.sequence)}
              disabled={!isConnected}
              className={key.accent ? KEY_BTN_ACCENT : KEY_BTN}
            >
              {key.label}
            </button>
          );
        })}

        <button
          type="button"
          onPointerDown={preventFocusSteal}
          onClick={scrollToBottom}
          disabled={!isConnected}
          className={KEY_BTN}
          title={t('terminalShortcuts.scrollDown')}
          aria-label={t('terminalShortcuts.scrollDown')}
        >
          <ArrowDownToLine className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
