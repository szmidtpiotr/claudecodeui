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

/**
 * - `report`: a derived session's server-started turn ended (automatic);
 * - `message`: a derived session sent its parent a message on purpose
 *   (send_to_parent_session), e.g. because the user asked it to.
 */
export type DerivedReportKind = 'report' | 'message';

export type DerivedSessionReport = {
  kind: DerivedReportKind;
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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// `[Wiadomość od sesji pochodnej „<title>” (<uuid>)]`
const CHILD_MESSAGE_HEADER_PATTERN = new RegExp(`^\\[Wiadomość od sesji pochodnej „([\\s\\S]*?)” \\((${UUID})\\)\\]\\n?`, 'i');

// `[Wiadomość od sesji nadrzędnej „<title>” (<id>)]` — the parent id may be any
// session id, so it is matched loosely.
const PARENT_MESSAGE_HEADER_PATTERN = /^\[Wiadomość od sesji nadrzędnej(?: „([\s\S]*?)”)? \(([^()\s]{1,120})\)\]\n?/i;

/** Longest message a session may send to its parent or child in one go. */
export const MAX_SESSION_MESSAGE_LENGTH = 20000;

/** A message a derived session sends its parent on purpose (send_to_parent_session). */
export function buildDerivedChildMessage(input: {
  childSessionId: string;
  childTitle: string;
  text: string;
}): string {
  const header = `[Wiadomość od sesji pochodnej „${oneLine(input.childTitle) || input.childSessionId}” (${input.childSessionId})]`;
  return `${header}\n${input.text.trim()}`;
}

/** A message a parent sends one of its derived sessions (send_to_derived_session). */
export function buildParentSessionMessage(input: {
  parentSessionId: string;
  parentTitle: string | null;
  text: string;
}): string {
  const title = input.parentTitle ? oneLine(input.parentTitle) : '';
  const header = `[Wiadomość od sesji nadrzędnej${title ? ` „${title}”` : ''} (${input.parentSessionId})]`;
  return `${header}\n${input.text.trim()}`;
}

export type ParentSessionMessage = {
  parentSessionId: string;
  parentTitle: string | null;
  body: string;
};

/** Recognises a message from the parent session; null for any other text. */
export function parseParentSessionMessage(content: string): ParentSessionMessage | null {
  if (typeof content !== 'string') {
    return null;
  }
  const trimmed = content.trimStart();
  const match = PARENT_MESSAGE_HEADER_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    parentTitle: match[1] ?? null,
    parentSessionId: match[2],
    body: trimmed.slice(match[0].length),
  };
}

/** Recognises a report or a child's message; null for any other text. */
export function parseDerivedReportMessage(content: string): DerivedSessionReport | null {
  if (typeof content !== 'string') {
    return null;
  }
  const trimmed = content.trimStart();
  const message = CHILD_MESSAGE_HEADER_PATTERN.exec(trimmed);
  if (message) {
    return {
      kind: 'message',
      childTitle: message[1],
      childSessionId: message[2].toLowerCase(),
      status: 'completed',
      body: trimmed.slice(message[0].length),
    };
  }
  const match = REPORT_HEADER_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    kind: 'report',
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
    'Gdy później użytkownik poprosi cię o przekazanie czegoś sesji nadrzędnej, użyj narzędzia send_to_parent_session.',
    '',
    input.task.trim(),
  ].join('\n');
}

export type DerivedSessionTask = {
  parentSessionId: string;
  parentTitle: string | null;
  /** The instruction the derived session started with. */
  task: string;
};

const TASK_HEADER_PATTERN = /^\[Sesja pochodna\] Uruchomiła cię sesja (?:„([\s\S]*?)” \(([^()\s]{1,120})\)|([^\s.]{1,120}))\./;

/** Recognises the first prompt of an agent-created derived session; null otherwise. */
export function parseDerivedSessionPrompt(content: string): DerivedSessionTask | null {
  if (typeof content !== 'string') {
    return null;
  }
  const trimmed = content.trimStart();
  const match = TASK_HEADER_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  // The technical header ends at the first blank line; the task follows.
  const split = trimmed.indexOf('\n\n');
  return {
    parentTitle: match[1] ?? null,
    parentSessionId: match[2] ?? match[3],
    task: split >= 0 ? trimmed.slice(split + 2).trim() : '',
  };
}
