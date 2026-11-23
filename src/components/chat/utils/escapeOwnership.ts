/**
 * Matches an open layer that dismisses itself on Escape: a menu, a modal
 * dialog, or any overlay marked with `data-escape-layer`. Page-wide Escape
 * handlers (stopping a running chat turn) step aside while one is open, so
 * dismissing the layer is all that Escape does.
 */
export const ESCAPE_LAYER_SELECTOR = '[data-escape-layer], [aria-modal="true"], [role="menu"]';

// Input types that hold no text. Escape on one of these (a focused checkbox or
// button) is not cancelling anything, so it still counts toward stopping the turn.
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether the element is a field the user types into, where Escape has its own meaning. */
function isTextEntryElement(element: HTMLElement): boolean {
  if (element.isContentEditable) {
    return true;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  return element instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(element.type);
}

/**
 * Whether an Escape belongs to some other part of the page rather than to the
 * running turn: it was typed into a text field other than the composer (an
 * inline session/project rename, the terminal, the code editor), or an open
 * menu or modal dialog is about to close on it.
 *
 * The abort listener runs in the document capture phase, ahead of every handler
 * on the focused element, so a rename input's `stopPropagation` cannot shield
 * its Escape; ownership has to be decided here instead.
 */
export function isEscapeOwnedElsewhere(event: KeyboardEvent, composer: HTMLTextAreaElement | null): boolean {
  const { target } = event;
  if (target instanceof HTMLElement && target !== composer && isTextEntryElement(target)) {
    return true;
  }
  return document.querySelector(ESCAPE_LAYER_SELECTOR) !== null;
}
