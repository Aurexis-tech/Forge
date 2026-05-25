// Unit test: SoftwareSpec Zod schema (Phase 3 intake).
//
// Covers the schema-level invariants:
//   - accepts a valid spec
//   - requires at least one page and one entity
//   - rejects duplicate page ids + duplicate entity names
//   - rejects flows that reference unknown page ids
//   - rejects unknown field types (only the FIELD_TYPES enum is valid)
//   - rejects entity names that aren't PascalCase
//   - rejects page ids that aren't lower_snake_case

import { describe, expect, it } from 'vitest';
import { SoftwareSpecSchema } from '@/lib/engine/software/spec';

const baseSpec = {
  goal: 'A team expenses tracker with manager approval.',
  pages: [
    { id: 'submit_expense', name: 'Submit', purpose: 'A user submits a new expense.' },
    { id: 'my_history', name: 'My history', purpose: 'A user sees their own past expenses.' },
    { id: 'approvals', name: 'Approvals', purpose: 'A manager approves or rejects pending expenses.' },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'submitted_by', type: 'reference' },
        { name: 'amount', type: 'number' },
        { name: 'description', type: 'text' },
        { name: 'submitted_at', type: 'datetime' },
        { name: 'approval_status', type: 'enum' },
      ],
    },
    {
      name: 'User',
      fields: [
        { name: 'email', type: 'email' },
        { name: 'role', type: 'enum' },
      ],
    },
  ],
  flows: [
    {
      name: 'Submit and route to approver',
      description: 'A user submits an expense; it lands in their manager’s approvals queue.',
      pages: ['submit_expense', 'approvals'],
    },
  ],
  auth: { requires_auth: true, roles: ['member', 'manager'], per_user_isolation: true },
};

describe('SoftwareSpecSchema', () => {
  it('accepts the canonical expenses-tracker spec', () => {
    const parsed = SoftwareSpecSchema.safeParse(baseSpec);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.pages).toHaveLength(3);
      expect(parsed.data.entities).toHaveLength(2);
      expect(parsed.data.flows).toHaveLength(1);
      expect(parsed.data.auth.requires_auth).toBe(true);
      expect(parsed.data.auth.per_user_isolation).toBe(true);
    }
  });

  it('rejects duplicate page ids', () => {
    const spec = {
      ...baseSpec,
      pages: [
        baseSpec.pages[0],
        { ...baseSpec.pages[1], id: 'submit_expense' }, // duplicate id
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.message.includes('duplicate page id')),
      ).toBe(true);
    }
  });

  it('rejects duplicate entity names', () => {
    const spec = {
      ...baseSpec,
      entities: [
        baseSpec.entities[0],
        { ...baseSpec.entities[1], name: 'Expense' }, // duplicate name
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes('duplicate entity name'),
        ),
      ).toBe(true);
    }
  });

  it('rejects flows that reference unknown page ids', () => {
    const spec = {
      ...baseSpec,
      flows: [
        {
          name: 'broken flow',
          description: 'walks pages that do not exist',
          pages: ['submit_expense', 'ghost_page'], // ghost_page is not declared
        },
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) =>
          i.message.includes("'ghost_page'"),
        ),
      ).toBe(true);
    }
  });

  it('rejects unknown field types', () => {
    const spec = {
      ...baseSpec,
      entities: [
        {
          name: 'Expense',
          // 'currency' is not in FIELD_TYPES — must be one of string,
          // text, number, boolean, date, datetime, email, url, enum,
          // reference.
          fields: [{ name: 'amount', type: 'currency' }],
        },
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('rejects entity names that are not PascalCase', () => {
    const spec = {
      ...baseSpec,
      entities: [
        { name: 'expense', fields: [{ name: 'amount', type: 'number' }] },
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('rejects page ids that are not lower_snake_case', () => {
    const spec = {
      ...baseSpec,
      pages: [
        { id: 'SubmitExpense', name: 'Submit', purpose: 'p' },
        { id: 'history', name: 'History', purpose: 'p' },
      ],
    };
    const parsed = SoftwareSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
  });

  it('requires at least one page and one entity', () => {
    const noPages = SoftwareSpecSchema.safeParse({ ...baseSpec, pages: [] });
    expect(noPages.success).toBe(false);

    const noEntities = SoftwareSpecSchema.safeParse({
      ...baseSpec,
      entities: [],
    });
    expect(noEntities.success).toBe(false);
  });

  it('accepts a public app (no auth, no per-user isolation)', () => {
    const publicSpec = {
      ...baseSpec,
      auth: { requires_auth: false, per_user_isolation: false },
    };
    const parsed = SoftwareSpecSchema.safeParse(publicSpec);
    expect(parsed.success).toBe(true);
  });
});
