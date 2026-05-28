// INFRASTRUCTURE SPEC ADDENDUM — extends lib/engine/spec/quality.ts.
//
// Engine-owned, eval-referenced. Note that infra has NO codegen LLM
// (IaC composer is deterministic), so this addendum governs extraction
// only — the cheapest place to enforce catalog-grounded resource choices.

import type { SpecQualityCriterion } from '../spec/quality';

export const INFRA_SPEC_ADDENDUM_VERSION = '1.0.0';

export const INFRA_SPEC_ADDENDUM_IDS = [
  'infra_resources_from_catalog',
  'infra_topology_explicit',
  'infra_lifecycle_declared',
  'infra_region_and_sizing_concrete',
] as const;
export type InfraSpecAddendumId = (typeof INFRA_SPEC_ADDENDUM_IDS)[number];

export const INFRA_SPEC_ADDENDUM: readonly SpecQualityCriterion[] = [
  {
    id: 'infra_resources_from_catalog',
    label: 'Every resource picked from the RESOURCE_TYPES catalog',
    imperative:
      'Each `resources[].type` MUST be one of: `postgres_db`, `object_store`, `queue`, `worker`, `cron`, `http_service`, `cache`, `secret_store`, `cdn`. Pick the closest match; do not invent new types. When the user mentions a third-party service ("Datadog", "Stripe"), capture it via the relevant resource\'s `config` map — not as a new resource type.',
    rationale:
      'The IaC composer maps each resource type to a fixed module. An unrecognised type silently drops the resource from the composed plan.',
  },
  {
    id: 'infra_topology_explicit',
    label: 'Topology dependencies named, not implied',
    imperative:
      'When one resource depends on another (worker reads from postgres_db, cron triggers worker, http_service writes to queue), record it in `topology[]` as a `{from, to}` edge using the resource ids. Both ids MUST be present in `resources[]`. Do not lose dependencies that the user clearly implied.',
    rationale:
      "The planner orders provisioning by topology. Missing edges produce out-of-order applies that fail at runtime ('table does not exist yet').",
  },
  {
    id: 'infra_lifecycle_declared',
    label: 'Lifecycle (ephemeral vs persistent) declared',
    imperative:
      "Set `lifecycle` to `ephemeral` (preview / per-PR environments / scratch) or `persistent` (production data / shared services). When the user mentions \"production\" or \"keep the data\" pick `persistent`. When they mention \"preview\" / \"temporary\" / \"sandbox\" pick `ephemeral`. Do not leave this implicit — the IaC composer routes destroy-policies differently per lifecycle.",
    rationale:
      "Lifecycle drives the destroy boundary. A `persistent` postgres_db marked `ephemeral` is a data-loss bomb on the next teardown.",
  },
  {
    id: 'infra_region_and_sizing_concrete',
    label: 'Region (when mentioned) + sizing hints captured concretely',
    imperative:
      'When the user names a region ("us-east-1", "EU"), set `region` to a recognisable slug. When they mention sizing ("small", "10 GB", "burst to 4 workers"), capture it in the resource\'s `sizing` field (`storage_gb`, `instances`, or `note`). Do not encode sizing as free text in the `goal`.',
    rationale:
      'Region + sizing are the two free-text intents that most often get lost between extraction and provisioning. Capturing them on the resource keeps them with the thing they describe.',
  },
];
