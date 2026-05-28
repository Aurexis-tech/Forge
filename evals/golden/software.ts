// Aurexis Forge — eval golden case: SOFTWARE mold.
//
// "Expense tracker" — a small Next.js + Supabase app: submit an
// expense, approve it, and see your own history. Auth-gated +
// per-user isolation (RLS), so the structural non-negotiables (no
// hand-rolled auth, RLS on every entity) are exercised by the
// deterministic dispatch — and the LLM only fills routes + pages.
//
// PINNED SoftwareSpec + SoftwareBuildPlan. Held constant when we
// tune the per-slot codegen prompt.

import type { SoftwareSpec } from '@/lib/engine/software/spec';
import type { SoftwareBuildPlan } from '@/lib/engine/software/planner/schema';
import type { GoldenCase } from './types';

const spec: SoftwareSpec = {
  goal: 'A small expense tracker: users submit expenses, view their own history, and mark each as approved when ready.',
  pages: [
    {
      id: 'list_expenses',
      name: 'My expenses',
      purpose:
        'List the signed-in user\'s expenses with amount, category, status, and date.',
    },
    {
      id: 'new_expense',
      name: 'Submit expense',
      purpose: 'Form to submit a new expense (amount, currency, category, description).',
    },
    {
      id: 'expense_detail',
      name: 'Expense detail',
      purpose:
        'View one expense in full and toggle approved status for a submitted expense the user owns.',
    },
  ],
  entities: [
    {
      name: 'Expense',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'currency', type: 'string' },
        { name: 'category', type: 'string' },
        { name: 'description', type: 'text' },
        { name: 'incurred_on', type: 'date' },
        { name: 'approved', type: 'boolean' },
      ],
    },
  ],
  flows: [
    {
      name: 'submit_expense',
      description:
        'User opens new_expense, fills the form, and lands on expense_detail for the new row.',
      pages: ['new_expense', 'expense_detail'],
    },
    {
      name: 'view_history',
      description:
        'User opens list_expenses to see all of their own expenses, then drills into one.',
      pages: ['list_expenses', 'expense_detail'],
    },
    {
      name: 'approve_own',
      description: 'User toggles the approved flag on their own expense from expense_detail.',
      pages: ['expense_detail'],
    },
  ],
  auth: {
    requires_auth: true,
    roles: [],
    per_user_isolation: true,
  },
  integrations: [],
};

const plan: SoftwareBuildPlan = {
  template_id: 'nextjs-supabase-app',
  tasks: [
    // --- schema layer ---
    {
      id: 'entity_migration_expense',
      layer: 'schema',
      description: 'Emit the canonical expense table migration with RLS pre-enabled.',
      depends_on: [],
      slot: { kind: 'entity_migration', target: 'Expense' },
      files: [],
    },
    {
      id: 'rls_policy_expense',
      layer: 'schema',
      description: 'Declare per-user RLS policies for the expense table.',
      depends_on: ['entity_migration_expense'],
      slot: { kind: 'rls_policy', target: 'Expense' },
      files: [],
    },
    // --- api layer ---
    {
      id: 'list_route_expense',
      layer: 'api',
      description:
        'GET handler that returns the signed-in user\'s expenses ordered by incurred_on desc.',
      depends_on: ['entity_migration_expense'],
      slot: { kind: 'list_route', target: 'Expense' },
      files: ['app/api/expense/_list.ts'],
    },
    {
      id: 'create_route_expense',
      layer: 'api',
      description:
        'POST handler that validates input + inserts an expense owned by the signed-in user.',
      depends_on: ['entity_migration_expense'],
      slot: { kind: 'create_route', target: 'Expense' },
      files: ['app/api/expense/_create.ts'],
    },
    {
      id: 'update_route_expense',
      layer: 'api',
      description:
        'PATCH handler at /api/expense/[id] — used to toggle the approved flag on the owner\'s own row.',
      depends_on: ['entity_migration_expense'],
      slot: { kind: 'update_route', target: 'Expense' },
      files: ['app/api/expense/[id]/_update.ts'],
    },
    // --- ui layer ---
    {
      id: 'page_list_expenses',
      layer: 'ui',
      description:
        'Server component that fetches the owner\'s expenses via the list route and renders the table.',
      depends_on: ['list_route_expense'],
      slot: { kind: 'page_component', target: 'list_expenses' },
      files: ['app/(app)/list-expenses/page.tsx'],
    },
    {
      id: 'page_new_expense',
      layer: 'ui',
      description:
        'Client component with a controlled form that POSTs to the create route.',
      depends_on: ['create_route_expense'],
      slot: { kind: 'page_component', target: 'new_expense' },
      files: ['app/(app)/new-expense/page.tsx'],
    },
    {
      id: 'page_expense_detail',
      layer: 'ui',
      description:
        'Detail view + an "Approve" toggle that PATCHes the update route.',
      depends_on: ['list_route_expense', 'update_route_expense'],
      slot: { kind: 'page_component', target: 'expense_detail' },
      files: ['app/(app)/expense-detail/page.tsx'],
    },
    // --- auth layer (declarative — template provides the code) ---
    {
      id: 'session_middleware_wiring',
      layer: 'auth',
      description:
        'Declares that the template-provided middleware.ts is the auth gate for the whole app.',
      depends_on: [],
      slot: { kind: 'session_middleware', target: null },
      files: [],
    },
    {
      id: 'per_user_isolation_wiring',
      layer: 'auth',
      description:
        'Declares that the per-user RLS check helpers wire the policies created above.',
      depends_on: ['rls_policy_expense'],
      slot: { kind: 'per_user_isolation_check', target: null },
      files: [],
    },
  ],
  execution_order: [
    'entity_migration_expense',
    'rls_policy_expense',
    'session_middleware_wiring',
    'list_route_expense',
    'create_route_expense',
    'update_route_expense',
    'per_user_isolation_wiring',
    'page_list_expenses',
    'page_new_expense',
    'page_expense_detail',
  ],
  warnings: [],
};

export const SOFTWARE_GOLDEN: GoldenCase = {
  id: 'software.expense_tracker',
  kind: 'software',
  description:
    'Expense tracker — submit / approve / per-user history (auth + RLS).',
  // Natural-language INTENT for the spec-fidelity tier.
  intent:
    'A small expense tracker app. Signed-in users submit expenses with amount, currency, category, and a description, view a list of their own expenses sorted by date, drill into one expense to see details, and mark it approved when ready. Each user only ever sees their own expenses.',
  spec,
  plan,
  contract: {
    expectedFilePaths: [
      // LLM-filled (route per-method files + page components).
      'app/api/expense/_list.ts',
      'app/api/expense/_create.ts',
      'app/api/expense/[id]/_update.ts',
      'app/(app)/list-expenses/page.tsx',
      'app/(app)/new-expense/page.tsx',
      'app/(app)/expense-detail/page.tsx',
      // Template-emitted, but their presence is the non-negotiable.
      'middleware.ts',
      'lib/auth/roles.ts',
      'lib/auth/rls.ts',
      'app/sign-in/page.tsx',
      'supabase/migrations/0001_init.sql',
    ],
    forbiddenImportPatterns: [
      // The server/client boundary: LLM-filled files must NEVER import
      // the browser supabase client OR the service-role key. This catches
      // the most consequential codegen regression.
      /supabase\/browser/,
      /SUPABASE_SERVICE_ROLE_KEY/,
    ],
    requiredFileContents: [
      {
        // Migration must enable RLS on the expense table — checks the
        // structural non-negotiable end-to-end.
        path: 'supabase/migrations/0001_init.sql',
        mustMatchAny: [/enable\s+row\s+level\s+security/i],
      },
      {
        // Create route should reference the entity / table by name —
        // signals the LLM actually used the spec, not a stub.
        path: 'app/api/expense/_create.ts',
        mustMatchAny: [/expense/i],
      },
    ],
  },
};
