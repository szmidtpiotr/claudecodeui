import express from 'express';

import { credentialsDb, usageStatsDb } from '../modules/database/index.js';
import { getClaudeUsage } from '../services/claudeUsageService.js';

const router = express.Router();

// GET /daily — per-day × model token totals from local session logs.
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&refresh=1 (all optional).
router.get('/daily', async (req, res) => {
  try {
    const { from, to } = req.query;
    await usageStatsDb.scan(req.query.refresh === '1');
    res.json({
      success: true,
      timezone: usageStatsDb.timezone(),
      updatedAt: usageStatsDb.lastScanAt(),
      days: usageStatsDb.getDaily(from, to),
    });
  } catch (error) {
    console.error('Error building daily usage stats:', error);
    res.status(500).json({ error: 'Failed to build daily usage stats' });
  }
});

// GET /hourly?date=YYYY-MM-DD — per-hour × model totals for one day.
router.get('/hourly', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Missing required query param: date' });
    await usageStatsDb.scan(false);
    res.json({
      success: true,
      timezone: usageStatsDb.timezone(),
      date,
      hours: usageStatsDb.getHourly(date),
    });
  } catch (error) {
    console.error('Error building hourly usage stats:', error);
    res.status(500).json({ error: 'Failed to build hourly usage stats' });
  }
});

// GET /projects — per-project × model totals over a date range.
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional).
router.get('/projects', async (req, res) => {
  try {
    const { from, to } = req.query;
    await usageStatsDb.scan(false);
    res.json({
      success: true,
      timezone: usageStatsDb.timezone(),
      projects: usageStatsDb.getProjects(from, to),
    });
  } catch (error) {
    console.error('Error building project usage stats:', error);
    res.status(500).json({ error: 'Failed to build project usage stats' });
  }
});

router.get('/claude', async (req, res) => {
  try {
    const userId = req.user.id;
    const forceRefresh = req.query.refresh === '1';

    const sessionKey = credentialsDb.getActiveCredential(userId, 'claude_session');
    if (!sessionKey) {
      return res.json({ success: true, data: null, hasSessionKey: false });
    }

    const data = await getClaudeUsage(userId, sessionKey, forceRefresh);
    res.json({ success: true, data, hasSessionKey: true });
  } catch (error) {
    console.error('Error fetching Claude usage:', error);
    res.status(500).json({ error: 'Failed to fetch Claude usage' });
  }
});

export default router;
