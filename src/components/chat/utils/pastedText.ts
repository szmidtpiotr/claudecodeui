/**
 * Long pastes are kept out of the composer textarea: the text is held as a
 * block and a short marker stands in its place. At send time every marker
 * still present in the input is replaced by its text, so the message is
 * exactly what a plain paste would have produced.
 */
export type PastedTextBlock = {
  id: number;
  text: string;
};

export const countLines = (text: string): number => (text ? text.split(/\r\n|\r|\n/).length : 0);

export const pastedTextMarker = (block: PastedTextBlock): string =>
  `[Pasted text #${block.id} +${countLines(block.text)} lines]`;

export const shouldCollapsePaste = (
  text: string,
  limits: { minChars: number; minLines: number },
): boolean => text.length > limits.minChars || countLines(text) > limits.minLines;

export const nextPastedTextId = (blocks: PastedTextBlock[]): number =>
  blocks.reduce((max, block) => Math.max(max, block.id), 0) + 1;

/** Blocks whose marker is still in the input, in marker order. */
export const blocksInInput = (input: string, blocks: PastedTextBlock[]): PastedTextBlock[] =>
  blocks
    .filter((block) => input.includes(pastedTextMarker(block)))
    .sort((a, b) => input.indexOf(pastedTextMarker(a)) - input.indexOf(pastedTextMarker(b)));

/** Replaces every marker present in the input with the text it stands for. */
export const expandPastedText = (input: string, blocks: PastedTextBlock[]): string => {
  let result = input;
  for (const block of blocks) {
    // split/join, not replace(): pasted text may contain `$&` and similar patterns.
    result = result.split(pastedTextMarker(block)).join(block.text);
  }
  return result;
};

export const removePastedTextMarker = (input: string, block: PastedTextBlock): string =>
  input.split(pastedTextMarker(block)).join('');

const isBlock = (value: unknown): value is PastedTextBlock =>
  Boolean(value)
  && typeof (value as PastedTextBlock).id === 'number'
  && typeof (value as PastedTextBlock).text === 'string';

export const parseStoredBlocks = (raw: string | null): PastedTextBlock[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isBlock) : [];
  } catch {
    return [];
  }
};
