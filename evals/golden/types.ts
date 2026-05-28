// Shared types for the eval golden-case registry.
//
// A GoldenCase pins a fixed (spec, plan) pair for ONE LLM-driven
// mold. The runner walks the registry, drives each case through the
// real generator, and scores the output. Spec + plan are HELD
// CONSTANT across runs — the only thing that moves between
// before/after comparisons is the generation prompt + model.

import type { AgentSpec } from '@/lib/engine/spec/schema';
import type { BuildPlan } from '@/lib/engine/planner/schema';
import type { SystemSpec } from '@/lib/engine/system/spec';
import type { OrchestrationPlan } from '@/lib/engine/system/planner/schema';
import type { SoftwareSpec } from '@/lib/engine/software/spec';
import type { SoftwareBuildPlan } from '@/lib/engine/software/planner/schema';
import type { InfraSpec } from '@/lib/engine/infra/spec';

// The structural contract a generated build MUST satisfy. Hand-
// authored alongside the spec + plan so the structural tier has a
// concrete target to check against (not just "any output").
export interface GoldenCaseContract {
  // Files the build is REQUIRED to contain. The structural tier
  // fails the case when any path here is missing from the output.
  expectedFilePaths: string[];
  // Optional — when set, the structural tier asserts this path is
  // present. (For agent / system molds we surface the entrypoint
  // explicitly; software has many entrypoints.)
  entrypointPath?: string;
  // Imports that, if present in any generated file, are an
  // immediate structural failure. The strongest example: the
  // browser supabase client appearing in a server route handler.
  forbiddenImportPatterns: RegExp[];
  // Additional spot-checks: a path must contain at least one
  // matching pattern. Used to catch "real spec content" not just
  // generic boilerplate.
  requiredFileContents: Array<{
    path: string;
    mustMatchAny: RegExp[];
  }>;
}

// Discriminated union — the case carries the right (spec, plan) pair
// for its mold. The runner dispatches on `kind`.
//
// `intent` (added for the spec-fidelity leg) is the natural-language
// input that SHOULD produce that case's pinned spec when fed through
// the per-mold extractor. The pinned `spec` field is the "good spec"
// reference the spec-fidelity tier scores against.
//
// `plan` is undefined on the infra case (P4 codegen is deterministic
// — no LLM, no generation tier — so the generation tier skips infra).
// All other code paths key off `kind` discriminator.
export type GoldenCase =
  | {
      id: string;
      kind: 'agent';
      description: string;
      intent: string;
      spec: AgentSpec;
      plan: BuildPlan;
      contract: GoldenCaseContract;
    }
  | {
      id: string;
      kind: 'system';
      description: string;
      intent: string;
      spec: SystemSpec;
      plan: OrchestrationPlan;
      contract: GoldenCaseContract;
    }
  | {
      id: string;
      kind: 'software';
      description: string;
      intent: string;
      spec: SoftwareSpec;
      plan: SoftwareBuildPlan;
      contract: GoldenCaseContract;
    }
  | {
      id: string;
      kind: 'infrastructure';
      description: string;
      intent: string;
      spec: InfraSpec;
      // Infra has no LLM-driven codegen — the spec-fidelity tier
      // applies; the generation tier is skipped for this kind.
      plan: undefined;
      // Lighter contract for infra: no generation files to check, so
      // most fields are unused. Kept for shape parity.
      contract: GoldenCaseContract;
    };
