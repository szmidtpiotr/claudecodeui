import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';

import { projectsDb } from '../modules/database/index.js';

const router = express.Router();
const DEFAULT_FILENAME = 'notes.md';

function getProjectPath(projectId) {
    return projectsDb.getProjectPathById(projectId);
}

function resolveNotesFile(projectPath, rawFile) {
    const filename = path.basename(rawFile || DEFAULT_FILENAME);
    if (!filename.endsWith('.md') || filename.length > 128) return null;
    return path.join(projectPath, filename);
}

// GET /api/notes/:projectId/files — list .md files in project root
router.get('/:projectId/files', async (req, res) => {
    try {
        const projectPath = getProjectPath(req.params.projectId);
        if (!projectPath) return res.status(404).json({ error: 'Project not found' });

        let entries;
        try {
            entries = await fs.readdir(projectPath, { withFileTypes: true });
        } catch {
            return res.json({ files: [DEFAULT_FILENAME] });
        }

        const mdFiles = entries
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => e.name)
            .sort();

        if (!mdFiles.includes(DEFAULT_FILENAME)) mdFiles.unshift(DEFAULT_FILENAME);

        res.json({ files: mdFiles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/notes/:projectId?file=notes.md — read file from project root
router.get('/:projectId', async (req, res) => {
    try {
        const projectPath = getProjectPath(req.params.projectId);
        if (!projectPath) return res.status(404).json({ error: 'Project not found' });

        const notesPath = resolveNotesFile(projectPath, req.query.file);
        if (!notesPath) return res.status(400).json({ error: 'Invalid filename' });

        try {
            const [content, stat] = await Promise.all([
                fs.readFile(notesPath, 'utf8'),
                fs.stat(notesPath),
            ]);
            res.json({ content, updatedAt: stat.mtimeMs, file: path.basename(notesPath) });
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.json({ content: '', updatedAt: null, file: path.basename(notesPath) });
            } else {
                throw err;
            }
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notes/:projectId?file=notes.md — write file to project root
router.put('/:projectId', async (req, res) => {
    try {
        const projectPath = getProjectPath(req.params.projectId);
        if (!projectPath) return res.status(404).json({ error: 'Project not found' });

        const notesPath = resolveNotesFile(projectPath, req.query.file);
        if (!notesPath) return res.status(400).json({ error: 'Invalid filename' });

        const { content } = req.body;
        if (content === undefined || content === null) {
            return res.status(400).json({ error: 'content is required' });
        }

        await fs.writeFile(notesPath, String(content), 'utf8');
        const stat = await fs.stat(notesPath);
        res.json({ success: true, updatedAt: stat.mtimeMs, file: path.basename(notesPath) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
