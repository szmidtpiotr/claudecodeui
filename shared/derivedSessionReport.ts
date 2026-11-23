/**
 * The message a derived session sends back to its parent when one of its
 * headless turns ends, and the first prompt a derived session starts with.
 *
 * Shared by the server (which writes them into the transcripts) and the chat
 * UI (which recognises a report in the parent's history and renders it as a
 * "message from derived session" row with a link to the child).
 */

/** Longest child reply copied into a report; the rest stays in the child. */
export const MAX_DERIVED_REPORT_TEXT_LENGTH = 4000;

export type DerivedReportStatus = 'completed' | 'error';

export type DerivedSessionReport = {
  childSessionId: string;
  childTitle: string;
  status: DerivedReportStatus;
  /** The child's final reply (or error text), possibly truncated. */
  body: string;
};

const STATUS_PHRASE: Record<DerivedReportStatus, string> = {
  completed: 'zakończyła turę',
  error: 'zakończyła turę błędem',
};

// `[Sesja pochodna „<title>” (<uuid>) zakończyła turę]` — the title may hold
// any characters, so the id and the fixed phrase anchor the match.
const REPORT_HEADER_PATTERN = /^\[Sesja pochodna „([\s\S]*?)” \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\) (zakończyła turę błędem|zakończyła turę)\]\n?/i;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Cuts a long reply and says so, so the parent knows to look in the child. */
export function truncateReportText(text: string, limit = MAX_DERIVED_REPORT_TEXT_LENGTH): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}…\n\n[Odpowiedź obcięta do ${limit} z ${trimmed.length} znaków; pełna treść jest w sesji pochodnej.]`;
}

export function buildDerivedReportMessage(input: {
  childSessionId: string;
  childTitle: string;
  status: DerivedReportStatus;
  text: string | null;
}): string {
  const header = `[Sesja pochodna „${oneLine(input.childTitle) || input.childSessionId}” (${input.childSessionId}) ${STATUS_PHRASE[input.status]}]`;
  const body = input.text && input.text.trim()
    ? truncateReportText(input.text)
    : input.status === 'error'
      ? '(bez szczegółów błędu)'
      : '(sesja pochodna nie zwróciła tekstu)';
  return `${header}\n${body}`;
}

/** Recognises a report message; null for any other text. */
export function parseDerivedReportMessage(content: string): DerivedSessionReport | null {
  if (typeof content !== 'string') {
    return null;
  }
  const match = REPORT_HEADER_PATTERN.exec(content.trimStart());
  if (!match) {
    return null;
  }
  return {
    childTitle: match[1],
    childSessionId: match[2].toLowerCase(),
    status: match[3].toLowerCase() === STATUS_PHRASE.error ? 'error' : 'completed',
    body: content.trimStart().slice(match[0].length),
  };
}

/** First message of a fresh derived session: a short header, then the task. */
export function buildDerivedSessionPrompt(input: {
  parentSessionId: string;
  parentTitle: string | null;
  task: string;
}): string {
  const parent = input.parentTitle
    ? `„${oneLine(input.parentTitle)}” (${input.parentSessionId})`
    : input.parentSessionId;
  return [
    `[Sesja pochodna] Uruchomiła cię sesja ${parent}. Nie znasz jej historii — wszystko, czego potrzebujesz, jest w zadaniu poniżej.`,
    'Twoja ostatnia odpowiedź w tej turze zostanie automatycznie wysłana do sesji nadrzędnej, więc zakończ ją zwięzłym raportem.',
    '',
    input.task.trim(),
  ].join('\n');
}
