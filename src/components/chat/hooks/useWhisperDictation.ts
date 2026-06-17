import { useCallback, useRef, useState } from 'react';
import { loadWhisperSettings } from '../../settings/view/tabs/VoiceSettingsTab';
import { IS_PLATFORM } from '../../../constants/config';

type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

interface UseWhisperDictationOptions {
  onTranscription: (text: string) => void;
}

// Peak amplitude below this (0..1) is treated as "no audio" — covers a muted mic
// or an input device that captured pure silence.
const SILENCE_PEAK_THRESHOLD = 0.01;

// Decode the recorded clip and report whether it is effectively silent. Decodes a
// COPY so the caller's ArrayBuffer stays intact for sending (decodeAudioData
// detaches the buffer it is given). On any decode error, returns false so a decode
// hiccup never blocks a real recording from being transcribed.
async function isSilent(audioData: ArrayBuffer): Promise<boolean> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return false;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(audioData.slice(0));
    const channel = decoded.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const amp = Math.abs(channel[i]);
      if (amp > peak) {
        peak = amp;
        if (peak >= SILENCE_PEAK_THRESHOLD) return false; // early-out: real audio
      }
    }
    return peak < SILENCE_PEAK_THRESHOLD;
  } catch {
    return false;
  } finally {
    void ctx.close();
  }
}

export function useWhisperDictation({ onTranscription }: UseWhisperDictationOptions) {
  const [state, setState] = useState<DictationState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const setError = useCallback((msg: string) => {
    console.error('[Whisper STT]', msg);
    setErrorMessage(msg);
    setState('error');
    setTimeout(() => setState('idle'), 4000);
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setErrorMessage(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const { url } = loadWhisperSettings();
      const upstreamWs = url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/voice/stt';
      // Route through the app's own WS server to avoid mixed-content blocks on HTTPS pages.
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = IS_PLATFORM ? null : localStorage.getItem('auth-token');
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      const wsUrl = `${wsProtocol}//${window.location.host}/voice-stt?target=${encodeURIComponent(upstreamWs)}${tokenParam}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      chunksRef.current = [];

      ws.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        setError('WebSocket failed — check Voice settings URL');
      };

      ws.onopen = () => {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setState('transcribing');

          try {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
            const arrayBuffer = await blob.arrayBuffer();

            // Guard against a muted/silent microphone: decode the captured audio and
            // check its peak amplitude. A muted mic still records (a valid but silent
            // WebM), so without this the user gets no feedback — the clip is sent and
            // the service just returns an empty transcription. Warn explicitly instead.
            if (await isSilent(arrayBuffer)) {
              try { ws.close(); } catch { /* noop */ }
              wsRef.current = null;
              setError('No audio detected — is your microphone muted?');
              return;
            }

            if (ws.readyState === WebSocket.OPEN) {
              ws.send(arrayBuffer);
              ws.send('__end__');
            } else {
              setError('WebSocket closed before audio was sent');
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        };

        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data as string) as { text?: string; language?: string; confidence?: number; error?: string };
            if (data.error) {
              setError(`Service error: ${data.error}`);
              return;
            }
            const text = (data.text || '').trim();
            console.log('[Whisper STT] result:', { text, language: data.language, confidence: data.confidence });
            if (text) {
              onTranscription(text);
              setState('idle');
            } else {
              // Audio had sound but nothing recognizable (silence, noise, or a
              // language the model isn't set to). Tell the user instead of silently
              // returning to idle with no inserted text.
              setError('No speech recognized — try again');
            }
          } catch {
            setError('Invalid response from voice service');
          }
          ws.close();
          wsRef.current = null;
        };

        recorder.start(); // no timeslice — produces a single well-formed WebM file
        setState('recording');
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('Permission') ? 'Microphone permission denied' : msg);
    }
  }, [onTranscription, setError]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (state === 'recording') {
      stopRecording();
    } else if (state === 'idle') {
      void startRecording();
    }
  }, [state, startRecording, stopRecording]);

  return { state, errorMessage, toggleRecording };
}
