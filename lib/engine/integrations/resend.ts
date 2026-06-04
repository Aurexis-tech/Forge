// Resend send — the ONE module that reads RESEND_API_KEY.
//
// This is the server-held credential boundary for the governed email
// action. The key is read here and NOWHERE else: it is never injected
// into generated code, never serialized into a forged artifact, never
// returned to a tool caller, never logged. The governance broker
// (lib/engine/governance/broker.ts) calls this ONLY after a human has
// approved the held action.
//
// Implemented as a raw fetch (no `resend` npm dependency) — one fewer
// dependency, and it keeps the key + the wire format in a single ~30-line
// surface that's easy to audit. Swap to the SDK later if needed; the
// broker only depends on the exported function shape.

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      'RESEND_API_KEY is not set on the Forge server — the governed email ' +
        'send cannot be performed. This is a server-side credential, not BYOK.',
    );
    this.name = 'EmailNotConfiguredError';
  }
}

export class EmailSendFailedError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'EmailSendFailedError';
    this.status = status;
  }
}

export interface ResendSendInput {
  readonly to: string | string[];
  readonly subject: string;
  readonly body: string;
  readonly from?: string;
}
export interface ResendSendResult {
  readonly message_id: string;
}

/** Default sender — overridable per-call, falls back to the configured
 *  FROM address or a safe placeholder the user is expected to override. */
const DEFAULT_FROM =
  (process.env.RESEND_FROM ?? '').trim() || 'Aurexis Forge <onboarding@resend.dev>';

/**
 * Perform the real Resend send. Reads RESEND_API_KEY from server env (the
 * ONLY read of that key in the codebase). Throws EmailNotConfiguredError
 * if the key is absent — so a missing credential is a clean, typed halt,
 * never a silent no-op.
 */
export async function sendEmailViaResend(
  input: ResendSendInput,
): Promise<ResendSendResult> {
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  if (!key) throw new EmailNotConfiguredError();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: input.from ?? DEFAULT_FROM,
      to: input.to,
      subject: input.subject,
      text: input.body,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new EmailSendFailedError(
      'Resend send failed (' + res.status + ')' + (detail ? ': ' + detail : ''),
      res.status,
    );
  }

  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { message_id: data.id ?? 'resend-' + res.status };
}
