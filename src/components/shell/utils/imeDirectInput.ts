import type { Terminal } from '@xterm/xterm';

const DEL = '\x7f';

/** Dispatched on the terminal's textarea to forget the text typed so far. */
export const IME_RESET_EVENT = 'ccui-ime-reset';

/**
 * What to type so a program that already received `previous` ends up with
 * `next`: backspaces for the part that changed, then the new tail.
 */
export function diffTypedText(previous: string, next: string): string {
  let common = 0;
  const limit = Math.min(previous.length, next.length);
  while (common < limit && previous[common] === next[common]) {
    common++;
  }

  return DEL.repeat(previous.length - common) + next.slice(common);
}

/**
 * Sends every letter to the program the moment it is typed on a phone keyboard.
 *
 * Phone keyboards build a word as an IME "composition". xterm.js keeps a
 * composition in a local overlay and sends it only when the word is finished,
 * so the program (and anything it echoes) lags a whole word behind the fingers.
 * Here the composition events are kept away from xterm.js and the hidden
 * textarea is mirrored to the program change by change instead - including the
 * backspaces needed when the keyboard rewrites a word (autocorrect, a tapped
 * suggestion).
 *
 * Only for touch keyboards: desktop IMEs (CJK input) rely on the stock
 * composition handling.
 */
export function attachImeDirectInput(container: HTMLElement, terminal: Terminal): () => void {
  const textarea = terminal.textarea;
  if (!textarea) {
    return () => {};
  }

  // What the program has been sent from the textarea so far.
  let mirrored = textarea.value;

  const resetTextarea = () => {
    textarea.value = '';
    mirrored = '';
  };

  const fromTextarea = (event: Event) => event.target === textarea;

  const hideFromXterm = (event: Event) => {
    if (fromTextarea(event)) {
      event.stopPropagation();
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!fromTextarea(event)) {
      return;
    }

    // 229 = "handled by the IME": the change arrives as an input event, and
    // xterm.js must not run its own (word-delayed) handling for it.
    if (event.keyCode === 229 || event.isComposing) {
      event.stopPropagation();
      return;
    }

    // A real Enter goes through xterm.js; start the next line with a clean
    // textarea so it does not grow for the whole session.
    if (event.key === 'Enter') {
      window.setTimeout(resetTextarea, 0);
    }
  };

  const handleInput = (event: Event) => {
    if (!fromTextarea(event)) {
      return;
    }

    event.stopPropagation();
    const inputType = (event as InputEvent).inputType;

    // xterm.js already sent pasted text from the paste event itself.
    if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') {
      resetTextarea();
      return;
    }

    // Some keyboards deliver Enter as a line break in the text.
    if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
      terminal.input('\r', true);
      resetTextarea();
      return;
    }

    const next = textarea.value;
    const data = diffTypedText(mirrored, next);
    mirrored = next;
    if (data) {
      terminal.input(data, true);
    }
  };

  // xterm.js clears the textarea on blur and paste; pick up whatever is there.
  const resync = () => {
    mirrored = textarea.value;
  };

  const options = { capture: true } as const;
  container.addEventListener('compositionstart', hideFromXterm, options);
  container.addEventListener('compositionupdate', hideFromXterm, options);
  container.addEventListener('compositionend', hideFromXterm, options);
  container.addEventListener('keydown', handleKeyDown, options);
  container.addEventListener('input', handleInput, options);
  container.addEventListener('focusin', resync, options);
  textarea.addEventListener(IME_RESET_EVENT, resetTextarea);

  return () => {
    textarea.removeEventListener(IME_RESET_EVENT, resetTextarea);
    container.removeEventListener('compositionstart', hideFromXterm, options);
    container.removeEventListener('compositionupdate', hideFromXterm, options);
    container.removeEventListener('compositionend', hideFromXterm, options);
    container.removeEventListener('keydown', handleKeyDown, options);
    container.removeEventListener('input', handleInput, options);
    container.removeEventListener('focusin', resync, options);
  };
}
