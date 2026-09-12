import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  latestMessage: any | null;
  isConnected: boolean;
  onPageVisible: (callback: () => void) => () => void;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

/**
 * How long a message queued while the socket was down stays worth sending.
 * Older entries are dropped rather than replayed into a session the user has
 * long since moved on from.
 */
const OUTBOUND_QUEUE_TTL_MS = 60_000;

/** Hard cap so a long offline stretch cannot grow the queue without bound. */
const OUTBOUND_QUEUE_LIMIT = 50;

/**
 * How long the resume liveness probe waits for a `pong` before it treats the
 * socket as half-open and forces a reconnect.
 */
const LIVENESS_PROBE_TIMEOUT_MS = 4000;

type QueuedMessage = { message: any; queuedAt: number };

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pageVisibleCallbacksRef = useRef<Set<() => void>>(new Set());
  // Messages handed to sendMessage while the socket was not OPEN, waiting for
  // the next successful connection.
  const outboundQueueRef = useRef<QueuedMessage[]>([]);
  // Lets handlers registered once (visibility, sendMessage) reach the current
  // `connect` without re-registering on every token change.
  const connectRef = useRef<() => void>(() => {});
  const livenessProbeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Every connect attempt supersedes the previous one; handlers belonging to an
  // older attempt are ignored so a stale `onclose` cannot schedule a second
  // reconnect on top of the one already in flight.
  const connectionEpochRef = useRef(0);
  const pendingSocketRef = useRef<WebSocket | null>(null);
  const { token } = useAuth();

  // Notify subscribers when the browser tab becomes visible again
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        // A phone freezes a backgrounded PWA: the socket is already gone but
        // neither `onclose` nor the 3s reconnect timer runs until the app is
        // resumed, and the socket may even still report OPEN over a TCP
        // connection the network dropped. Reconnect when it is visibly dead,
        // and probe with a ping when it only claims to be alive — otherwise
        // the first prompt after resume is sent into a black hole.
        const socket = wsRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reconnectNow();
        } else {
          probeLiveness();
        }

        for (const cb of pageVisibleCallbacksRef.current) {
          cb();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    // React remounts an effect (StrictMode in dev, or any provider remount)
    // after running its cleanup. Without clearing the flag the cleanup set,
    // every later connect() would bail out and the app would sit there with no
    // socket at all — prompts typed into it go nowhere.
    unmountedRef.current = false;
    connectRef.current = connect;
    connect();
    
    return () => {
      unmountedRef.current = true;
      if (livenessProbeTimeoutRef.current) {
        clearTimeout(livenessProbeTimeoutRef.current);
        livenessProbeTimeoutRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const flushOutboundQueue = useCallback((socket: WebSocket) => {
    const pending = outboundQueueRef.current;
    outboundQueueRef.current = [];

    const now = Date.now();
    for (const entry of pending) {
      if (now - entry.queuedAt > OUTBOUND_QUEUE_TTL_MS) {
        continue;
      }
      try {
        socket.send(JSON.stringify(entry.message));
      } catch (error) {
        console.error('Failed to flush queued WebSocket message:', error);
      }
    }
  }, []);

  const reconnectNow = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    // A socket already dialling will resolve on its own; opening a second one
    // would leave an orphan racing the first.
    if (pendingSocketRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }
    connectRef.current();
  }, []);

  const probeLiveness = useCallback(() => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (livenessProbeTimeoutRef.current) {
      return; // a probe is already in flight
    }

    try {
      socket.send(JSON.stringify({ type: 'ping' }));
    } catch {
      reconnectNow();
      return;
    }

    livenessProbeTimeoutRef.current = setTimeout(() => {
      livenessProbeTimeoutRef.current = null;
      // No pong came back, so the socket is half-open: it reports OPEN while
      // the connection underneath is gone. Drop it and dial again, otherwise
      // every send() succeeds locally and the message never arrives.
      const stale = wsRef.current;
      wsRef.current = null;
      setIsConnected(false);
      try {
        stale?.close();
      } catch {
        /* already gone */
      }
      reconnectNow();
    }, LIVENESS_PROBE_TIMEOUT_MS);
  }, [reconnectNow]);

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const epoch = ++connectionEpochRef.current;
      const isCurrent = () => epoch === connectionEpochRef.current && !unmountedRef.current;

      const previous = pendingSocketRef.current;
      if (previous && previous.readyState <= WebSocket.OPEN) {
        try {
          previous.close();
        } catch {
          /* already gone */
        }
      }

      const websocket = new WebSocket(wsUrl);
      pendingSocketRef.current = websocket;

      websocket.onopen = () => {
        if (!isCurrent()) {
          try {
            websocket.close();
          } catch {
            /* already gone */
          }
          return;
        }
        setIsConnected(true);
        wsRef.current = websocket;
        // Anything typed while the socket was down goes out first, in order.
        flushOutboundQueue(websocket);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setLatestMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (!isCurrent()) return;
        try {
          const data = JSON.parse(event.data);
          if (data?.type === 'pong') {
            if (livenessProbeTimeoutRef.current) {
              clearTimeout(livenessProbeTimeoutRef.current);
              livenessProbeTimeoutRef.current = null;
            }
            return;
          }
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (!isCurrent()) return;
        setIsConnected(false);
        wsRef.current = null;

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [flushOutboundQueue, token]); // everytime token changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(message));
        return;
      } catch (error) {
        console.error('WebSocket send failed, queueing message:', error);
      }
    }

    // Dropping the message here is how a prompt typed straight after the app
    // was resumed used to vanish: the socket was not OPEN yet and the only
    // trace was a console warning. Queue it and flush it once reconnected.
    outboundQueueRef.current.push({ message, queuedAt: Date.now() });
    if (outboundQueueRef.current.length > OUTBOUND_QUEUE_LIMIT) {
      outboundQueueRef.current.shift();
    }
    reconnectNow();
  }, [reconnectNow]);

  const onPageVisible = useCallback((callback: () => void) => {
    pageVisibleCallbacksRef.current.add(callback);
    return () => pageVisibleCallbacksRef.current.delete(callback);
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected,
    onPageVisible,
  }), [sendMessage, latestMessage, isConnected, onPageVisible]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
