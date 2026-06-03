import { getConnection } from '@/modules/database/connection.js';

interface ProjectNoteRow {
    project_id: string;
    content: string;
    updated_at: string;
}

export const notesDb = {
    getProjectNote(projectId: string): ProjectNoteRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, content, updated_at
            FROM project_notes
            WHERE project_id = ?
        `).get(projectId) as ProjectNoteRow | undefined;

        return row ?? null;
    },

    upsertProjectNote(projectId: string, content: string): void {
        const db = getConnection();
        db.prepare(`
            INSERT INTO project_notes (project_id, content, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(project_id) DO UPDATE SET
                content = excluded.content,
                updated_at = CURRENT_TIMESTAMP
        `).run(projectId, content);
    },
};
