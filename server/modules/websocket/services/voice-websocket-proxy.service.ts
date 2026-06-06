import { WebSocket } from 'ws';

/**
 * Proxies browser WebSocket → voice STT service.
 * Needed when the app is served over HTTPS: browsers block ws:// from https:// pages (mixed content).
 * Client connects to /voice-stt?target=<encoded upstream WS URL>.
 * The server-side connection to the voice service is plain ws:// (no mixed-content restriction).
 */
export function handleVoiceWsProxy(clientWs: WebSocket, searchParams: URLSearchParams): void {
  const rawTarget = searchParams.get('target');
  if (!rawTarget) {
    clientWs.close(4400, 'Missing target param');
    return;
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(decodeURIComponent(rawTarget));
  } catch {
    clientWs.close(4400, 'Invalid target URL');
    return;
  }

  if (!['ws:', 'wss:'].includes(targetUrl.protocol)) {
    clientWs.close(4400, 'Target must be ws:// or wss://');
    return;
  }

  const upstream = new WebSocket(targetUrl.toString());
  upstream.binaryType = 'arraybuffer';

  upstream.on('open', () => {
    console.log(`[Voice STT] Proxy connected to ${targetUrl.toString()}`);
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  upstream.on('error', (error) => {
    console.error('[Voice STT] Upstream error:', error.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(4502, 'Upstream error');
  });

  clientWs.on('error', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}
