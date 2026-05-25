// Server-Sent Events helper for routes that want to stream progress.
//
// The shape every route emits is a small typed envelope so the client can
// drive a single console + live status. Final state ALWAYS reaches the DB
// through the same path the polling route uses — streaming is purely a
// progress channel.

import { GovernanceError } from '@/lib/engine/governance/guard';

export type StreamEvent =
  | { kind: 'phase'; name: string; status: 'started' | 'ok' | 'failed' }
  | { kind: 'log'; level?: 'info' | 'warn' | 'error'; message: string }
  | { kind: 'delta'; section?: string; text: string }
  | { kind: 'meta'; data: Record<string, unknown> }
  | { kind: 'done'; result?: Record<string, unknown> }
  | { kind: 'error'; message: string; reason?: string };

export interface StreamChannel {
  emit(event: StreamEvent): void;
  // Convenience helpers used by routes.
  phase(name: string, status: 'started' | 'ok' | 'failed'): void;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  delta(text: string, section?: string): void;
  meta(data: Record<string, unknown>): void;
  done(result?: Record<string, unknown>): void;
  error(message: string, reason?: string): void;
  close(): void;
  // Promise that resolves when the response stream is closed (so the route
  // handler can keep work in flight in a structured way).
  readonly closed: Promise<void>;
}

// Wraps a route handler so it can write SSE events. The handler runs inside
// the writer; finishing it (or throwing) closes the stream cleanly.
//
// IMPORTANT: events MUST NOT contain secrets, tokens, or env values. The
// stream goes over HTTP and may pass through logs.
export function sseRoute(
  handler: (channel: StreamChannel) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let resolveClosed!: () => void;
  const closedP = new Promise<void>((res) => (resolveClosed = res));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const channel = makeChannel(controller, encoder, () => closed);

      // SSE preamble — comment line keeps proxies from buffering.
      controller.enqueue(encoder.encode(': stream opened\n\n'));

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore — controller may already be closed
        }
        resolveClosed();
      };

      try {
        await handler({ ...channel, close, closed: closedP });
      } catch (err) {
        const message =
          err instanceof GovernanceError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'unknown stream error';
        try {
          controller.enqueue(
            encoder.encode(
              formatEvent({
                kind: 'error',
                message,
                reason:
                  err instanceof GovernanceError ? err.reason : undefined,
              }),
            ),
          );
        } catch {
          // ignore
        }
      } finally {
        close();
      }
    },
    cancel() {
      closed = true;
      resolveClosed();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      // Hint to platforms that buffer responses (Vercel, nginx) to flush.
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

function makeChannel(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  isClosed: () => boolean,
): Omit<StreamChannel, 'close' | 'closed'> {
  function emit(event: StreamEvent) {
    if (isClosed()) return;
    try {
      controller.enqueue(encoder.encode(formatEvent(event)));
    } catch {
      // Best-effort — if the consumer disconnected we just stop emitting.
    }
  }
  return {
    emit,
    phase: (name, status) => emit({ kind: 'phase', name, status }),
    log: (message, level) => emit({ kind: 'log', level, message }),
    delta: (text, section) => emit({ kind: 'delta', section, text }),
    meta: (data) => emit({ kind: 'meta', data }),
    done: (result) => emit({ kind: 'done', result }),
    error: (message, reason) => emit({ kind: 'error', message, reason }),
  };
}

function formatEvent(event: StreamEvent): string {
  // The browser EventSource API treats each "data:" block ending with a
  // blank line as one message. We always JSON-encode the event so the
  // client only has to parse one shape.
  return 'data: ' + JSON.stringify(event) + '\n\n';
}
