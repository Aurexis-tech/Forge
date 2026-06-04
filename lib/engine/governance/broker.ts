// Runtime governance broker — the server-side seam that makes "a forged
// artifact must not perform a governed action until Forge says yes" TRUE.
//
//   requestEmailSend()  — records a PENDING governed action + audits
//                         'email.send.requested'. Returns pending. NEVER sends.
//   approveGovernedAction() — the human approval. Audits the authorisation
//                         (actor 'user') BEFORE acting (mirrors the build-time
//                         push/deploy gate), then performs the real send with
//                         the SERVER-HELD credential, records the result +
//                         'email.send.executed'. Only this path sends.
//   blockGovernedAction()  — records 'email.send.blocked'. NEVER sends.
//
// The provider credential (RESEND_API_KEY) is held entirely inside
// lib/engine/integrations/resend.ts and reached ONLY here, only on
// approval. This module never reads the key, never returns it, never logs
// it. The deployed artifact never receives it.
//
// Storage + send are injected (GovernedActionStore + sendEmail) with real
// Supabase/Resend defaults, so the broker logic is fully unit-testable with
// zero DB and zero network.

import {
  sendEmailViaResend,
  type ResendSendInput,
  type ResendSendResult,
} from '@/lib/engine/integrations/resend';
import { getServerSupabase, type ForgeSupabase } from '@/lib/supabase';

export type GovernedActionType = 'email.send';
export type GovernedActionRisk = 'low' | 'medium' | 'high';
export type GovernedActionStatus = 'pending' | 'executed' | 'blocked' | 'failed';

export interface EmailSendPayload {
  readonly to: string | string[];
  readonly subject: string;
  readonly body: string;
  readonly from?: string;
}

export interface GovernedAction {
  readonly id: string;
  readonly project_id: string;
  readonly user_id: string | null;
  readonly type: GovernedActionType;
  readonly summary: string;
  readonly payload: EmailSendPayload;
  readonly risk: GovernedActionRisk;
  readonly status: GovernedActionStatus;
  readonly result: Record<string, unknown> | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
}

// --- Injectable seams (real defaults; tests pass fakes) --------------------

export interface AuditEntry {
  readonly project_id: string;
  readonly action: string;
  readonly actor: string;
  readonly detail: Record<string, unknown>;
}

export interface GovernedActionStore {
  insertPending(input: {
    project_id: string;
    user_id: string | null;
    type: GovernedActionType;
    summary: string;
    payload: EmailSendPayload;
    risk: GovernedActionRisk;
  }): Promise<GovernedAction>;
  get(id: string): Promise<GovernedAction | null>;
  update(
    id: string,
    patch: Partial<
      Pick<GovernedAction, 'status' | 'result' | 'error_message' | 'decided_at' | 'decided_by'>
    >,
  ): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
}

export type EmailSender = (input: ResendSendInput) => Promise<ResendSendResult>;

export interface BrokerDeps {
  store?: GovernedActionStore;
  sendEmail?: EmailSender;
}

// --- The Supabase-backed store (the real default) --------------------------

export function supabaseGovernedActionStore(
  supabase: ForgeSupabase = getServerSupabase(),
): GovernedActionStore {
  return {
    async insertPending(input) {
      const { data, error } = await supabase
        .from('governed_actions')
        .insert({
          project_id: input.project_id,
          user_id: input.user_id,
          type: input.type,
          summary: input.summary,
          payload: input.payload,
          risk: input.risk,
          status: 'pending',
        })
        .select('*')
        .single();
      if (error) throw error;
      return data as GovernedAction;
    },
    async get(id) {
      const { data, error } = await supabase
        .from('governed_actions')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data as GovernedAction | null) ?? null;
    },
    async update(id, patch) {
      const { error } = await supabase
        .from('governed_actions')
        .update(patch)
        .eq('id', id);
      if (error) throw error;
    },
    async audit(entry) {
      await supabase.from('audit_log').insert({
        project_id: entry.project_id,
        action: entry.action,
        actor: entry.actor,
        detail: entry.detail,
      });
    },
  };
}

function resolveDeps(deps?: BrokerDeps): Required<BrokerDeps> {
  return {
    store: deps?.store ?? supabaseGovernedActionStore(),
    sendEmail: deps?.sendEmail ?? sendEmailViaResend,
  };
}

// Detail blobs intentionally omit the body — the audit trail records THAT a
// send was requested/approved/sent and to whom, not the message contents.
function emailDetail(a: { to: string | string[]; subject: string }): Record<string, unknown> {
  return { to: a.to, subject: a.subject };
}

// --- The broker API --------------------------------------------------------

export interface RequestResult {
  readonly action_id: string;
  readonly status: 'pending';
}

/**
 * An artifact REQUESTS an email send. Records a pending governed action +
 * audits 'email.send.requested'. Returns pending — it does NOT send. The
 * send happens only if a human later approves.
 */
export async function requestEmailSend(input: {
  governance: { projectId: string; userId: string | null; actor?: string };
  summary: string;
  payload: EmailSendPayload;
  risk?: GovernedActionRisk;
}, deps?: BrokerDeps): Promise<RequestResult> {
  const { store } = resolveDeps(deps);
  const action = await store.insertPending({
    project_id: input.governance.projectId,
    user_id: input.governance.userId,
    type: 'email.send',
    summary: input.summary,
    payload: input.payload,
    risk: input.risk ?? 'medium',
  });
  await store.audit({
    project_id: input.governance.projectId,
    action: 'email.send.requested',
    // The agent/runtime asked; the human has not decided yet.
    actor: input.governance.actor ?? 'engine.runtime',
    detail: { action_id: action.id, ...emailDetail(input.payload), risk: action.risk },
  });
  return { action_id: action.id, status: 'pending' };
}

export type ApproveResult =
  | { status: 'executed'; message_id: string }
  | { status: 'failed'; error: string };

export class GovernedActionNotPendingError extends Error {
  readonly currentStatus: GovernedActionStatus | 'missing';
  constructor(currentStatus: GovernedActionStatus | 'missing') {
    super('governed action is not pending (status: ' + currentStatus + ')');
    this.name = 'GovernedActionNotPendingError';
    this.currentStatus = currentStatus;
  }
}

/**
 * The human approves a pending governed action. Mirrors the build-time
 * gate: audit the authorisation (actor 'user') BEFORE acting, THEN perform
 * the real send with the server-held credential. Records 'email.send.executed'
 * + the message_id on success, or 'email.send.failed' on a send error. A
 * non-pending action is refused (no double-send, no replay).
 */
export async function approveGovernedAction(args: {
  actionId: string;
  projectId: string;
  actor?: string;
}, deps?: BrokerDeps): Promise<ApproveResult> {
  const { store, sendEmail } = resolveDeps(deps);
  const action = await store.get(args.actionId);
  if (!action || action.status !== 'pending') {
    throw new GovernedActionNotPendingError(action ? action.status : 'missing');
  }
  const actor = args.actor ?? 'user';
  const decidedAt = new Date().toISOString();

  // Audit the human authorisation BEFORE acting (build-time gate pattern).
  await store.audit({
    project_id: args.projectId,
    action: 'email.send.approved',
    actor,
    detail: { action_id: action.id, ...emailDetail(action.payload) },
  });

  try {
    const { message_id } = await sendEmail({
      to: action.payload.to,
      subject: action.payload.subject,
      body: action.payload.body,
      from: action.payload.from,
    });
    await store.update(action.id, {
      status: 'executed',
      result: { message_id },
      decided_at: decidedAt,
      decided_by: actor,
    });
    await store.audit({
      project_id: args.projectId,
      action: 'email.send.executed',
      actor: 'integration.resend',
      detail: { action_id: action.id, message_id, ...emailDetail(action.payload) },
    });
    return { status: 'executed', message_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send failed';
    await store.update(action.id, {
      status: 'failed',
      error_message: msg,
      decided_at: decidedAt,
      decided_by: actor,
    });
    await store.audit({
      project_id: args.projectId,
      action: 'email.send.failed',
      actor: 'integration.resend',
      detail: { action_id: action.id, error: msg },
    });
    return { status: 'failed', error: msg };
  }
}

export interface BlockResult {
  readonly status: 'blocked';
}

/**
 * The human blocks a pending governed action. Records 'email.send.blocked'
 * and NEVER calls the sender. The held action is terminal — it can never
 * be performed by this intent.
 */
export async function blockGovernedAction(args: {
  actionId: string;
  projectId: string;
  actor?: string;
}, deps?: BrokerDeps): Promise<BlockResult> {
  const { store } = resolveDeps(deps);
  const action = await store.get(args.actionId);
  if (!action || action.status !== 'pending') {
    throw new GovernedActionNotPendingError(action ? action.status : 'missing');
  }
  const actor = args.actor ?? 'user';
  await store.update(action.id, {
    status: 'blocked',
    decided_at: new Date().toISOString(),
    decided_by: actor,
  });
  await store.audit({
    project_id: args.projectId,
    action: 'email.send.blocked',
    actor,
    detail: { action_id: action.id, ...emailDetail(action.payload) },
  });
  return { status: 'blocked' };
}
