import express from 'express';
import { WebSocket } from 'ws';

const router = express.Router();

const VOICE_SERVICE_URL = process.env.VOICE_SERVICE_URL || 'http://192.168.1.16:8300';

// Proxy health check
router.get('/healthz', async (req, res) => {
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/voice/healthz`);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Voice service unhealthy' });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Voice healthz error:', error.message);
    res.status(503).json({ error: 'Voice service unreachable' });
  }
});

// Proxy config endpoint
router.get('/config', async (req, res) => {
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/voice/config`);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch config' });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Voice config error:', error.message);
    res.status(503).json({ error: 'Voice service unreachable' });
  }
});

// Proxy config update
router.post('/config', async (req, res) => {
  try {
    const response = await fetch(`${VOICE_SERVICE_URL}/voice/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to update config' });
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Voice config update error:', error.message);
    res.status(503).json({ error: 'Voice service unreachable' });
  }
});

// WebSocket proxy handler — called from server upgrade handler for /api/voice/stt
export function handleVoiceWsUpgrade(req, socket, head, wss) {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamUrl = VOICE_SERVICE_URL.replace(/^http/, 'ws') + '/voice/stt';
    const upstream = new WebSocket(upstreamUrl);

    upstream.on('open', () => {
      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        }
      });
    });

    upstream.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    upstream.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
    });

    upstream.on('error', (err) => {
      console.error('Voice upstream WS error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
    });

    clientWs.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });

    clientWs.on('error', (err) => {
      console.error('Voice client WS error:', err.message);
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
  });
}

export default router;
