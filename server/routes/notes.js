import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

import { projectsDb } from '../modules/database/index.js';

const router = express.Router();
const NOTES_FILENAME = 'notes.md';

function getNotesPath(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    if (!projectPath) return null;
    return path.join(projectPath, NOTES_FILENAME);
}

// GET /api/notes/:projectId — read notes.md from project root
router.get('/:projectId', async (req, res) => {
    try {
        const notesPath = getNotesPath(req.params.projectId);
        if (!notesPath) return res.status(404).json({ error: 'Project not found' });

        try {
            const [content, stat] = await Promise.all([
                fs.readFile(notesPath, 'utf8'),
                fs.stat(notesPath),
            ]);
            res.json({ content, updatedAt: stat.mtimeMs });
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.json({ content: '', updatedAt: null });
            } else {
                throw err;
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notes/:projectId — write notes.md to project root
router.put('/:projectId', async (req, res) => {
    try {
        const notesPath = getNotesPath(req.params.projectId);
        if (!notesPath) return res.status(404).json({ error: 'Project not found' });

        const { content } = req.body;
        if (content === undefined || content === null) {
            return res.status(400).json({ error: 'content is required' });
        }

        await fs.writeFile(notesPath, String(content), 'utf8');
        const stat = await fs.stat(notesPath);
        res.json({ success: true, updatedAt: stat.mtimeMs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
