// Hermetic tests for the runtime governance broker — the safety seam that
// makes "a forged artifact must not perform a governed action until Forge
// says yes" TRUE. These are HONESTY GUARDS: a governed-action surface that
// sends without approval, sends on block, or leaks the credential is worse
// than none. So we prove, with an injected store + a sender SPY (zero DB,
// zero network):
//   - request → pending, NEVER sends
//   - block   → NEVER sends
//   - approve → sends EXACTLY once, via the server-held credential boundary
//   - non-pending → refused (no double-send / replay)
//   - the raw RESEND_API_KEY is read in exactly ONE module and never reaches
//     the artifact; the emitted scaffold is an honest throw, not a fake send.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveGovernedAction,
  blockGovernedAction,
  GovernedActionNotPendingError,
  requestEmailSend,
  type AuditEntry,
  type EmailSender,
  type GovernedAction,
  type GovernedActionStore,
} from '@/lib/engine/governance/broker';

const repo = (p: string) => path.resolve(__dirname, '..', '..', p);
const read = (p: string) => readFileSync(repo(p), 'utf8');

// --- In-memory store + sender spy (no DB, no network) ----------------------
function memStore() {
  const rows = new Map<string, GovernedAction>();
  const audits: AuditEntry[] = [];
  let n = 0;
  const store: GovernedActionStore = {
    async insertPending(input) {
      const id = 'ga_' + ++n;
      const row: GovernedAction = {
        id,
        project_id: input.project_id,
        user_id: input.user_id,
        type: input.type,
        summary: input.summary,
        payload: input.payload,
        risk: input.risk,
        status: 'pending',
        result: null,
        error_message: null,
        created_at: '2026-06-01T00:00:00.000Z',
        decided_at: null,
        decided_by: null,
      };
      rows.set(id, row);
      return row;
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async update(id, patch) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ...patch } as GovernedAction);
    },
    async audit(entry) {
      audits.push(entry);
    },
  };
  return { store, rows, audits };
}

function senderSpy(impl?: EmailSender) {
  const calls: Array<{ to: string | string[]; subject: string }> = [];
  const sendEmail: EmailSender = async (input) => {
    calls.push({ to: input.to, subject: input.subject });
    if (impl) return impl(input);
    return { message_id: 'msg_test_1' };
  };
  return { sendEmail, calls };
}

const GOV = { projectId: 'p1', userId: 'u1' };
const PAYLOAD = { to: 'me@example.com', subject: 'HN top story', body: 'Title — https://x' };

// ===========================================================================
// 1. request → PENDING, never sends
// ===========================================================================
describe('requestEmailSend — holds, never sends', () => {
  it('records a pending action + audits requested; sender is NOT called', async () => {
    const { store, rows, audits } = memStore();
    const { sendEmail, calls } = senderSpy();
    const res = await requestEmailSend(
      { governance: GOV, summary: 'email the brief', payload: PAYLOAD },
      { store, sendEmail },
    );
    expect(res.status).toBe('pending');
    expect(calls).toHaveLength(0); // NOTHING was sent
    const row = rows.get(res.action_id)!;
    expect(row.status).toBe('pending');
    expect(audits.map((a) => a.action)).toContain('email.send.requested');
    // The audit detail records to/subject, NOT the body (no content leak).
    const reqAudit = audits.find((a) => a.action === 'email.send.requested')!;
    expect(reqAudit.detail).not.toHaveProperty('body');
  });
});

// ===========================================================================
// 2. block → never sends
// ===========================================================================
describe('blockGovernedAction — blocks, never sends', () => {
  it('a blocked action makes NO send and audits email.send.blocked (actor user)', async () => {
    const { store, rows, audits } = memStore();
    const { sendEmail, calls } = senderSpy();
    const { action_id } = await requestEmailSend(
      { governance: GOV, summary: 's', payload: PAYLOAD },
      { store, sendEmail },
    );
    const res = await blockGovernedAction({ actionId: action_id, projectId: 'p1' }, { store, sendEmail });
    expect(res.status).toBe('blocked');
    expect(calls).toHaveLength(0); // the whole point: block sends NOTHING
    expect(rows.get(action_id)!.status).toBe('blocked');
    const blockAudit = audits.find((a) => a.action === 'email.send.blocked')!;
    expect(blockAudit.actor).toBe('user');
  });
});

// ===========================================================================
// 3. approve → sends EXACTLY once, with the real message_id
// ===========================================================================
describe('approveGovernedAction — only an explicit human approval sends', () => {
  it('approve performs ONE send and records executed + the message_id', async () => {
    const { store, rows, audits } = memStore();
    const { sendEmail, calls } = senderSpy(async () => ({ message_id: 'resend_abc' }));
    const { action_id } = await requestEmailSend(
      { governance: GOV, summary: 's', payload: PAYLOAD },
      { store, sendEmail },
    );
    expect(calls).toHaveLength(0); // still nothing sent at request time

    const res = await approveGovernedAction(
      { actionId: action_id, projectId: 'p1', actor: 'user' },
      { store, sendEmail },
    );
    expect(res).toEqual({ status: 'executed', message_id: 'resend_abc' });
    expect(calls).toHaveLength(1); // sent exactly once, only on approval
    expect(rows.get(action_id)!.status).toBe('executed');
    // Mirrors the build-time gate: the authorisation is audited actor='user'.
    const approved = audits.find((a) => a.action === 'email.send.approved')!;
    expect(approved.actor).toBe('user');
    expect(audits.map((a) => a.action)).toContain('email.send.executed');
  });

  it('a non-pending action is REFUSED — no double-send / replay', async () => {
    const { store, sendEmail, calls } = (() => {
      const m = memStore();
      const s = senderSpy();
      return { store: m.store, sendEmail: s.sendEmail, calls: s.calls };
    })();
    const { action_id } = await requestEmailSend(
      { governance: GOV, summary: 's', payload: PAYLOAD },
      { store, sendEmail },
    );
    await approveGovernedAction({ actionId: action_id, projectId: 'p1' }, { store, sendEmail });
    expect(calls).toHaveLength(1);
    // Second approve must throw (already executed) and send NOTHING more.
    await expect(
      approveGovernedAction({ actionId: action_id, projectId: 'p1' }, { store, sendEmail }),
    ).rejects.toBeInstanceOf(GovernedActionNotPendingError);
    expect(calls).toHaveLength(1); // STILL one — no replay
  });

  it('blocked-then-approve is refused (block is terminal, never sends)', async () => {
    const { store } = memStore();
    const { sendEmail, calls } = senderSpy();
    const { action_id } = await requestEmailSend(
      { governance: GOV, summary: 's', payload: PAYLOAD },
      { store, sendEmail },
    );
    await blockGovernedAction({ actionId: action_id, projectId: 'p1' }, { store, sendEmail });
    await expect(
      approveGovernedAction({ actionId: action_id, projectId: 'p1' }, { store, sendEmail }),
    ).rejects.toBeInstanceOf(GovernedActionNotPendingError);
    expect(calls).toHaveLength(0); // a blocked action can NEVER be sent
  });

  it('a send failure on approve records failed (not executed), returns failed', async () => {
    const { store, rows } = memStore();
    const { sendEmail } = senderSpy(async () => {
      throw new Error('resend 500');
    });
    const { action_id } = await requestEmailSend(
      { governance: GOV, summary: 's', payload: PAYLOAD },
      { store, sendEmail },
    );
    const res = await approveGovernedAction(
      { actionId: action_id, projectId: 'p1' },
      { store, sendEmail },
    );
    expect(res.status).toBe('failed');
    expect(rows.get(action_id)!.status).toBe('failed');
  });
});

// ===========================================================================
// 4. CREDENTIAL CONTAINMENT — RESEND_API_KEY read in exactly one module
// ===========================================================================
describe('credential containment (source guards)', () => {
  // Walk lib/ and find every .ts file that READS process.env.RESEND_API_KEY.
  function filesReadingResendKey(): string[] {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts')) continue;
        const src = readFileSync(full, 'utf8');
        if (/process\.env\.RESEND_API_KEY/.test(src)) {
          hits.push(path.relative(repo('.'), full).replace(/\\/g, '/'));
        }
      }
    };
    walk(repo('lib'));
    return hits;
  }

  it('process.env.RESEND_API_KEY is read in EXACTLY ONE module (resend.ts)', () => {
    expect(filesReadingResendKey()).toEqual(['lib/engine/integrations/resend.ts']);
  });

  it('the broker NEVER reads the raw key (it delegates to the resend module)', () => {
    expect(read('lib/engine/governance/broker.ts')).not.toMatch(/process\.env\.RESEND_API_KEY/);
  });

  it('the emitted agent scaffold never references RESEND_API_KEY (artifact never holds it)', () => {
    // EMAIL_SEND_SOURCE is the code shipped INTO the forged artifact.
    const planner = read('lib/engine/tools/builtin/planner-tools.ts');
    const src = planner.slice(planner.indexOf('EMAIL_SEND_SOURCE ='));
    const body = src.slice(0, src.indexOf('`;') + 2);
    expect(body).not.toContain('RESEND_API_KEY');
    // …and it does NOT fake a send: real branch throws (governed), mock
    // branch is gated by isMockMode and unmistakably returns 'mock-'.
    expect(body).toMatch(/throw new Error\([^)]*GOVERNED/s);
    expect(body).toContain('isMockMode');
    expect(body).toContain("message_id: 'mock-'");
  });
});

// ===========================================================================
// 5. TRANSPORT NOT FAKED + human-only decision (source guards)
// ===========================================================================
describe('honest seam — human-gated routes, no faked artifact transport', () => {
  it('approve/block are HUMAN-authenticated routes (requireUser + ownership + authorized:true)', () => {
    for (const r of ['approve', 'block']) {
      const route = read(
        'app/api/projects/[id]/governance/actions/[actionId]/' + r + '/route.ts',
      );
      expect(route).toMatch(/requireUser/);
      expect(route).toMatch(/requireProjectOwnership/);
      expect(route).toMatch(/authorized: z\.literal\(true\)/);
    }
  });

  it('approve performs the send via the broker; block never can', () => {
    const approve = read('app/api/projects/[id]/governance/actions/[actionId]/approve/route.ts');
    const block = read('app/api/projects/[id]/governance/actions/[actionId]/block/route.ts');
    expect(approve).toMatch(/approveGovernedAction/);
    expect(block).toMatch(/blockGovernedAction/);
    expect(block).not.toMatch(/sendEmail|approveGovernedAction/);
  });

  it('the emitted artifact does NOT call a Forge governance endpoint (transport unprovisioned, honest)', () => {
    // We must NOT fake the deployed-artifact→Forge transport. The scaffold
    // names the governed model + the unprovisioned transport and throws —
    // it does not POST to a nonexistent ingest endpoint.
    const planner = read('lib/engine/tools/builtin/planner-tools.ts');
    const src = planner.slice(planner.indexOf('EMAIL_SEND_SOURCE ='));
    const body = src.slice(0, src.indexOf('`;') + 2);
    expect(body).not.toMatch(/fetch\(/); // no half-built call to a missing endpoint
    expect(body).toMatch(/not provisioned/i); // honest about the remaining seam
  });
});
