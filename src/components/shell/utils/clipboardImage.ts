export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const imageFilesFrom = (list: FileList | null | undefined): File[] =>
  Array.from(list ?? []).filter((file) => IMAGE_MIME_TYPES.includes(file.type));

export type ClipboardContent =
  | { kind: 'image'; file: File }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  /** The browser gave no access: not HTTPS, permission denied, or no API. */
  | { kind: 'unavailable' };

/**
 * Reads the clipboard, preferring an image (a copied screenshot has no text
 * form) over text.
 */
export async function readClipboard(): Promise<ClipboardContent> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return { kind: 'unavailable' };
  }

  if (navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => IMAGE_MIME_TYPES.includes(candidate));
        if (type) {
          const blob = await item.getType(type);
          return { kind: 'image', file: new File([blob], `clipboard.${type.split('/')[1]}`, { type }) };
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          return text ? { kind: 'text', text } : { kind: 'empty' };
        }
      }
      return { kind: 'empty' };
    } catch {
      // Fall through: some browsers allow readText where read() is refused.
    }
  }

  if (navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      return text ? { kind: 'text', text } : { kind: 'empty' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return { kind: 'unavailable' };
}
