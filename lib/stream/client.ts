'use client';

// React hook for consuming an SSE stream. Mirrors the StreamEvent shape
// from sse.ts. POSTs (not GETs) work via fetch + a ReadableStream reader
// rather than EventSource (which only supports GET).

import { useCallback, useEffect, useRef, useState } from 'react';

export type StreamEvent =
  | { kind: 'phase'; name: string; status: 'started' | 'ok' | 'failed' }
  | { kind: 'log'; level?: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'delta'; section?: string; text: string }
  | { kind: 'meta'; data: Record<string, unknown> }
  | { kind: 'done'; result?: Record<string, unknown> }
  | { kind: 'error'; message: string; reason?: string };

export interface UseEventStreamOptions {
  // Pre-parse hook for custom logic per event. Return false to drop the
  // event from the default `events` log.
  onEvent?: (event: StreamEvent) => boolean | void;
  // Called when the stream ends cleanly (server closed, 'done' or 'error').
  onClose?: () => void;
}

export interface UseEventStream {
  start: (url: string, init?: RequestInit) => Promise<void>;
  stop: () => void;
  events: StreamEvent[];
  status: 'idle' | 'connecting' | 'streaming' | 'closed' | 'error';
  error: string | null;
}

export function useEventStream(opts: UseEventStreamOptions = {}): UseEventStream {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [status, setStatus] = useState<UseEventStream['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onEventRef = useRef(opts.onEvent);
  const onCloseRef = useRef(opts.onClose);
  onEventRef.current = opts.onEvent;
  onCloseRef.current = opts.onClose;

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const start = useCallback(async (url: string, init: RequestInit = {}) => {
    stop();
    const controller = new AbortController();
    abortRef.current = controller;
    setEvents([]);
    setError(null);
    setStatus('connecting');

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init.headers ?? {}),
          accept: 'text/event-stream',
        },
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : 'fetch failed';
      setStatus('error');
      setError(m);
      onCloseRef.current?.();
      throw err;
    }

    if (!res.ok || !res.body) {
      const message = 'stream HTTP ' + res.status;
      setStatus('error');
      setError(message);
      onCloseRef.current?.();
      throw new Error(message);
    }

    setStatus('streaming');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on the SSE delimiter (blank line).
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleChunk(chunk);
        }
      }
      // flush any trailing partial
      if (buffer.trim().length > 0) handleChunk(buffer);
      setStatus('closed');
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') {
        setStatus('closed');
      } else {
        setStatus('error');
        setError(err instanceof Error ? err.message : 'stream broke');
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      onCloseRef.current?.();
    }

    function handleChunk(raw: string) {
      // Each SSE event we emit is `data: <json>`; ignore other lines.
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const event = JSON.parse(json) as StreamEvent;
          const keep = onEventRef.current?.(event);
          if (keep !== false) {
            setEvents((prev) => [...prev, event]);
          }
        } catch {
          // Drop garbled events; never throw out of the reader.
        }
      }
    }
  }, [stop]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { start, stop, events, status, error };
}
