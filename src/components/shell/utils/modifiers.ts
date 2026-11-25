export type StickyModifiers = { ctrl: boolean; alt: boolean };

// Ctrl + these punctuation keys also map to control codes on a real keyboard.
const CTRL_PUNCTUATION: Record<string, string> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '-': '\x1f',
  '?': '\x7f',
};

/**
 * Applies the on-screen CTRL / ALT keys to one typed character, the way a
 * hardware keyboard would. Longer input (a paste, an arrow-key sequence) is
 * passed through unchanged.
 */
export function applyStickyModifiers(data: string, modifiers: StickyModifiers): string {
  if (data.length !== 1 || (!modifiers.ctrl && !modifiers.alt)) {
    return data;
  }

  let result = data;

  if (modifiers.ctrl) {
    // Phone keyboards capitalise the first letter; Ctrl+C and Ctrl+c are the same key.
    const code = data.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) {
      result = String.fromCharCode(code - 96);
    } else if (CTRL_PUNCTUATION[data] !== undefined) {
      result = CTRL_PUNCTUATION[data];
    }
  }

  if (modifiers.alt) {
    result = `\x1b${result}`;
  }

  return result;
}
