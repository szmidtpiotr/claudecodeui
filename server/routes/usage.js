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
      days: usageStatsDb.getDaily(from, to),
    });
  } catch (error) {
    console.error('Error building daily usage stats:', error);
    res.status(500).json({ error: 'Failed to build daily usage stats' });
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
