// Aurexis Forge — eval golden case: INFRASTRUCTURE mold.
//
// "Events pipeline with nightly backup" — a queue, a worker, a
// Postgres database, a cron job, and an object store, wired by a
// concrete topology in us-east-1, lifecycle=persistent.
//
// Infrastructure's CODEGEN is deterministic (IaC composer from
// catalog), so this case has NO generation tier — only the
// spec-fidelity tier scores it. The runner detects this via
// `plan: undefined` and skips the generation pass.
//
// PINNED InfraSpec — held constant when we tune the infra extractor
// prompt so we can compare before/after on a single variable.

import type { InfraSpec } from '@/lib/engine/infra/spec';
import type { GoldenCase } from './types';

const spec: InfraSpec = {
  goal: 'Ingest events through a queue, persist them to Postgres, and back up nightly to object storage.',
  resources: [
    {
      id: 'events_queue',
      type: 'queue',
      config: { ordering: 'fifo' },
    },
    {
      id: 'events_worker',
      type: 'worker',
      config: { runtime: 'node', concurrency: 2 },
    },
    {
      id: 'events_db',
      type: 'postgres_db',
      config: {
        version: '16',
        schema_hint: 'events(id, source, ts, payload)',
      },
      sizing: { storage_gb: 50 },
    },
    {
      id: 'nightly_backup',
      type: 'cron',
      config: { schedule: '0 3 * * *' },
    },
    {
      id: 'backup_bucket',
      type: 'object_store',
      config: { bucket_hint: 'events-backup' },
    },
  ],
  topology: [
    { from: 'events_worker', to: 'events_queue' },
    { from: 'events_worker', to: 'events_db' },
    { from: 'nightly_backup', to: 'events_db' },
    { from: 'nightly_backup', to: 'backup_bucket' },
  ],
  region: 'us-east-1',
  lifecycle: 'persistent',
};

export const INFRASTRUCTURE_GOLDEN: GoldenCase = {
  id: 'infrastructure.events_pipeline',
  kind: 'infrastructure',
  description:
    'Events pipeline: queue -> worker -> Postgres + nightly cron-backup to object storage.',
  intent:
    'An events pipeline in us-east-1: a FIFO queue, a Node worker that consumes the queue and writes to a Postgres 16 database (~50GB), and a nightly cron at 3am UTC that backs up the database to an object store bucket. Production — keep the data across deploys.',
  spec,
  // No plan — infra codegen is deterministic. The runner skips the
  // generation tier for this case.
  plan: undefined,
  contract: {
    // Infra has no LLM-driven generated files to score structurally;
    // the contract is light, kept for shape parity with the other
    // case kinds.
    expectedFilePaths: [],
    forbiddenImportPatterns: [],
    requiredFileContents: [],
  },
};
