// Unit test: InfraSpec Zod schema (Phase 4 intake).
//
// Covers the schema-level invariants:
//   - accepts a valid spec
//   - requires at least one resource
//   - rejects duplicate resource ids
//   - rejects topology edges that reference unknown resources
//   - rejects self-edges on a resource
//   - rejects unknown resource types (only the RESOURCE_TYPES catalog is valid)
//   - rejects resource ids that aren't lower_snake_case

import { describe, expect, it } from 'vitest';
import { InfraSpecSchema } from '@/lib/engine/infra/spec';

const baseSpec = {
  goal: 'A pipeline that ingests events hourly, stores them, and serves them via HTTP.',
  resources: [
    {
      id: 'event_ingest_cron',
      type: 'cron',
      config: { schedule: 'every hour' },
    },
    {
      id: 'ingest_worker',
      type: 'worker',
      config: { runtime: 'node', concurrency: 2 },
    },
    {
      id: 'events_db',
      type: 'postgres_db',
      config: { schema_hint: 'events table with id, source, ts, payload' },
    },
    {
      id: 'events_api',
      type: 'http_service',
      config: { framework: 'nextjs', endpoints: ['/events', '/health'] },
    },
  ],
  topology: [
    { from: 'event_ingest_cron', to: 'ingest_worker' },
    { from: 'ingest_worker', to: 'events_db' },
    { from: 'events_api', to: 'events_db' },
  ],
  lifecycle: 'persistent',
};

describe('InfraSpecSchema', () => {
  it('accepts the canonical events-pipeline spec', () => {
    const parsed = InfraSpecSchema.safeParse(baseSpec);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.resources).toHaveLength(4);
      expect(parsed.data.topology).toHaveLength(3);
      expect(parsed.data.lifecycle).toBe('persistent');
    }
  });

  it('rejects duplicate resource ids', () => {
    const spec = {
      ...baseSpec,
      resources: [
        baseSpec.resources[0],
        { ...baseSpec.resources[1], id: 'event_ingest_cron' }, // duplicate id
        ...baseSpec.resources.slice(2),
      ],
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.message.includes('duplicate resource id')),
      ).toBe(true);
    }
  });

  it('rejects topology edges that reference unknown resources', () => {
    const spec = {
      ...baseSpec,
      topology: [
        { from: 'event_ingest_cron', to: 'ingest_worker' },
        { from: 'ingest_worker', to: 'ghost_resource' }, // ghost
      ],
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes("'ghost_resource'"),
        ),
      ).toBe(true);
    }
  });

  it('rejects self-edges', () => {
    const spec = {
      ...baseSpec,
      topology: [{ from: 'ingest_worker', to: 'ingest_worker' }],
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.message.includes('self-edge')),
      ).toBe(true);
    }
  });

  it('rejects unknown resource types (catalog is closed)', () => {
    const spec = {
      ...baseSpec,
      resources: [
        // 'lambda' is not in RESOURCE_TYPES — must be one of postgres_db,
        // object_store, queue, worker, cron, http_service.
        { id: 'fn', type: 'lambda', config: {} },
      ],
      topology: [],
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('rejects resource ids that are not lower_snake_case', () => {
    const spec = {
      ...baseSpec,
      resources: [
        { id: 'EventsDB', type: 'postgres_db', config: {} },
      ],
      topology: [],
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('requires at least one resource', () => {
    const empty = InfraSpecSchema.safeParse({
      ...baseSpec,
      resources: [],
      topology: [],
    });
    expect(empty.success).toBe(false);
  });

  it('requires lifecycle to be one of the closed enum values', () => {
    const spec = { ...baseSpec, lifecycle: 'forever' };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('accepts a single-resource spec with empty topology', () => {
    const spec = {
      goal: 'A simple object store for backups.',
      resources: [
        { id: 'backup_bucket', type: 'object_store', config: { bucket_hint: 'nightly-backups' } },
      ],
      topology: [],
      lifecycle: 'persistent',
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(true);
  });

  it('accepts ephemeral lifecycle and optional region', () => {
    const spec = {
      ...baseSpec,
      lifecycle: 'ephemeral',
      region: 'eu-west-1',
    };
    const parsed = InfraSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lifecycle).toBe('ephemeral');
      expect(parsed.data.region).toBe('eu-west-1');
    }
  });
});
