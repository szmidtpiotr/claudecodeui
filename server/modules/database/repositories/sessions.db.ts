import { getConnection } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id?: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type SessionMetadataLookupRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'project_path' | 'jsonl_path' | 'custom_name' | 'isArchived' | 'created_at' | 'updated_at'
> & { provider_session_id?: string | null };

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  createSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    projectsDb.createProjectPath(normalizedProjectPath);

    db.prepare(
      `INSERT INTO sessions (session_id, provider, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = 0,
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
    ).run(
      sessionId,
      provider,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue
    );

    return sessionId;
  },

  /**
   * Re-points one session row at another project.
   *
   * Both the owning project and the transcript location move together: the
   * synchronizer rebuilds `project_path` from the `cwd` recorded inside the
   * JSONL file, so a caller that changes this row without also rewriting and
   * relocating the transcript would see the move reverted on the next scan.
   *
   * `updated_at` is deliberately left untouched so moving a session does not
   * reorder the activity-sorted sidebar feed.
   */
  updateSessionProject(sessionId: string, projectPath: string, jsonlPath: string): boolean {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);

    // The project row is a foreign key target, so it has to exist first.
    projectsDb.createProjectPath(normalizedProjectPath);

    return (
      db
        .prepare(
          `UPDATE sessions
           SET project_path = ?, jsonl_path = ?
           WHERE session_id = ?`
        )
        .run(normalizedProjectPath, jsonlPath, sessionId).changes > 0
    );
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionMetadataLookupRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at, provider_session_id
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionMetadataLookupRow | undefined;

    return row ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 0`
      )
      .all() as SessionRow[];
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  getRecentSessionsPage(limit: number, offset: number): RecentSessionsPage {
    const db = getConnection();
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
    `;
    const rows = db
      .prepare(
        `SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as SessionRow[];
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`
      )
      .get() as { count: number } | undefined;

    return {
      sessions: rows,
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  getArchivedSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`
      )
      .all() as SessionRow[];
  },

  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  getSessionsByProjectPathIncludingArchived(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?`
      )
      .all(normalizedProjectPath) as SessionRow[];
  },

  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT session_id, provider, project_path, jsonl_path, custom_name, isArchived, created_at, updated_at
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedProjectPath, limit, offset) as SessionRow[];
  },

  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`
      )
      .get(normalizedProjectPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    db.prepare(`DELETE FROM sessions WHERE project_path = ?`).run(normalizedProjectPath);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  updateSessionIsArchived(sessionId: string, isArchived: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`
    ).run(isArchived ? 1 : 0, sessionId);
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },
};
