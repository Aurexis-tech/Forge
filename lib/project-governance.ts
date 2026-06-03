// PURE view-models for the per-project Governance section on
// /projects/[id]. REAL DATA ONLY — every field here maps to a signal the
// engine genuinely writes:
//   - spend           → getProjectSpend (cost_events) — the page already loads it
//   - gate decisions  → audit_log rows whose `action` is a real
//                       AuthorizationGate decision (the closed set below)
//   - activity        → the project's audit_log rows (all of them)
//   - runtime status  → agent_runtimes.status for this project (or none)
//
// There is deliberately NO runtime-action feed here: the deployed artifact
// does not emit post-deploy actions back to Forge today, so the
// "Runtime monitoring" panel renders an honest empty state (copy below)
// rather than a fabricated feed or Approve/Block controls that gate
// nothing. Displaying fake actions or dead controls would be a false
// safety claim — so this module exposes neither.
//
// Tested directly in node — nothing here renders, nothing fetches.

import type { AuditLog, RuntimeStatus } from '@/lib/types';
import { auditActorTone, runtimeStatusVm } from '@/lib/governance-zones';

// ---------------------------------------------------------------------------
// Authorization decisions — the CLOSED set of audit_log actions that are
// real AuthorizationGate decisions Forge performs during a build (repo
// creation, plan approvals, pushes, deploys, provisioning, runtime
// activation) plus the kill-switch levers. Anything outside this set is
// "activity", not an authorization. Kept in sync with the engine's
// audit_log action vocabulary (grep `action: '…_authorized'` /
// `'…plan_approved'` / `'killswitch.*'`).
// ---------------------------------------------------------------------------

export const AUTHORIZATION_ACTIONS = [
  'plan.approved',
  'repo.create_authorized',
  'deploy.authorized',
  'software.plan_approved',
  'software.push_authorized',
  'software.deploy_authorized',
  'software.db_authorized',
  'software.runtime_authorized',
  'system.plan_approved',
  'system.push_authorized',
  'system.deploy_authorized',
  'infra.plan_approved',
  'killswitch.activated',
  'killswitch.cleared',
] as const;

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];

const AUTH_SET: ReadonlySet<string> = new Set(AUTHORIZATION_ACTIONS);

/** True when an audit action is one of the real authorization decisions. */
export function isAuthorizationAction(action: string): boolean {
  return AUTH_SET.has(action);
}

/** Human label for a real authorization action — what was requested/decided.
 *  Falls back to the raw action so an unknown-but-real row is never hidden. */
export function authorizationLabel(action: string): string {
  switch (action) {
    case 'plan.approved':
      return 'Build plan approved';
    case 'repo.create_authorized':
      return 'Create repository authorized';
    case 'deploy.authorized':
      return 'Deploy authorized';
    case 'software.plan_approved':
      return 'Software plan approved';
    case 'software.push_authorized':
      return 'Push to repository authorized';
    case 'software.deploy_authorized':
      return 'Deploy authorized';
    case 'software.db_authorized':
      return 'Database provisioning authorized';
    case 'software.runtime_authorized':
      return 'Runtime activation authorized';
    case 'system.plan_approved':
      return 'Orchestration plan approved';
    case 'system.push_authorized':
      return 'Push to repository authorized';
    case 'system.deploy_authorized':
      return 'Deploy authorized';
    case 'infra.plan_approved':
      return 'Provisioning plan approved';
    case 'killswitch.activated':
      return 'Kill switch engaged';
    case 'killswitch.cleared':
      return 'Kill switch cleared';
    default:
      return action;
  }
}

export type AuthDecisionTone = 'approved' | 'halt' | 'neutral';

/** Tone for an authorization row: approvals are mint ("approved"), a
 *  kill-switch engage is a rose halt, a clear is neutral. */
export function authorizationTone(action: string): AuthDecisionTone {
  if (action === 'killswitch.activated') return 'halt';
  if (action === 'killswitch.cleared') return 'neutral';
  return 'approved';
}

export interface AuthorizationEntryVm {
  readonly id: string;
  readonly action: string;
  readonly label: string;
  readonly actor: string;
  readonly tone: AuthDecisionTone;
  /** Raw ISO timestamp — formatting is the component's job (keeps this pure). */
  readonly at: string;
}

/** Map the project's audit rows → the authorization-history view-model
 *  (newest first). Only real authorization actions survive the filter. */
export function authorizationHistoryVm(
  rows: ReadonlyArray<AuditLog>,
): ReadonlyArray<AuthorizationEntryVm> {
  return rows
    .filter((r) => isAuthorizationAction(r.action))
    .map((r) => ({
      id: r.id,
      action: r.action,
      label: authorizationLabel(r.action),
      actor: r.actor,
      tone: authorizationTone(r.action),
      at: r.created_at,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// Activity — the honest version of the mockup's "Activity Logs": every
// audit_log row for the project, newest first, colored by real actor.
// ---------------------------------------------------------------------------

export interface ActivityEntryVm {
  readonly id: string;
  readonly action: string;
  readonly actor: string;
  readonly tone: ReturnType<typeof auditActorTone>;
  readonly at: string;
}

export function activityVm(
  rows: ReadonlyArray<AuditLog>,
): ReadonlyArray<ActivityEntryVm> {
  return rows
    .map((r) => ({
      id: r.id,
      action: r.action,
      actor: r.actor,
      tone: auditActorTone(r.actor),
      at: r.created_at,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// Stat strip — ONLY metrics with a real source. No "High Risk: 1", no
// "Actions Today: 6" — those have no source. Runtime is null when the
// project has no agent_runtimes row (rendered as "—").
// ---------------------------------------------------------------------------

export interface GovernanceStatsVm {
  /** Real project spend in USD (getProjectSpend). */
  readonly spendUsd: number;
  /** Count of real authorization decisions in the audit log. */
  readonly gateDecisions: number;
  /** Runtime status label + liveness, or null when no runtime row exists. */
  readonly runtime: { readonly label: string; readonly live: boolean } | null;
}

export function governanceStatsVm(input: {
  spendUsd: number;
  auditRows: ReadonlyArray<AuditLog>;
  runtimeStatus: RuntimeStatus | string | null | undefined;
}): GovernanceStatsVm {
  const gateDecisions = input.auditRows.filter((r) =>
    isAuthorizationAction(r.action),
  ).length;
  const runtime =
    input.runtimeStatus == null
      ? null
      : (() => {
          const vm = runtimeStatusVm(input.runtimeStatus);
          return { label: vm.label, live: vm.live };
        })();
  return {
    spendUsd: Number.isFinite(input.spendUsd) ? input.spendUsd : 0,
    gateDecisions,
    runtime,
  };
}

// ---------------------------------------------------------------------------
// Runtime monitoring — HONEST EMPTY STATE. The deployed artifact does not
// report its post-deploy actions back to Forge yet, so this panel shows a
// calm, clearly-labeled placeholder. NO fabricated agent rows, NO
// Approve/Block controls (those must not exist until the artifact can
// actually be gated). Single source for the copy so the panel can't drift
// into a false claim.
// ---------------------------------------------------------------------------

export const RUNTIME_MONITORING_COPY = {
  eyebrow: 'RUNTIME MONITORING',
  headline: 'Not available yet.',
  body:
    'Runtime action monitoring activates once this project is deployed ' +
    'and reporting its actions. Not available yet.',
} as const;
