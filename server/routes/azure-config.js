import express from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const router = express.Router();
const CONFIG_PATH = path.join(os.homedir(), '.azure-openai', 'config.json');

router.get('/config', async (req, res) => {
    try {
        const content = await readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(content);
        res.json({
            endpoint: config.endpoint || '',
            apiVersion: config.apiVersion || '2024-12-01-preview',
            hasApiKey: Boolean(config.apiKey),
        });
    } catch {
        res.json({ endpoint: '', apiVersion: '2024-12-01-preview', hasApiKey: false });
    }
});

router.post('/config', async (req, res) => {
    const { endpoint, apiKey, apiVersion } = req.body;

    if (!endpoint || !apiKey) {
        return res.status(400).json({ error: 'endpoint and apiKey are required' });
    }

    try {
        new URL(endpoint);
    } catch {
        return res.status(400).json({ error: 'Invalid endpoint URL' });
    }

    await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await writeFile(CONFIG_PATH, JSON.stringify({
        endpoint: endpoint.replace(/\/$/, ''),
        apiKey,
        apiVersion: apiVersion || '2024-12-01-preview',
    }, null, 2), 'utf8');

    res.json({ success: true });
});

export default router;
