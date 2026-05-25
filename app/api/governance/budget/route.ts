import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { isSupportedCurrency } from '@/lib/currencies';
import { deleteBudget, upsertBudget } from '@/lib/engine/governance/budgets';
import { toUsd } from '@/lib/fx';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

// The body accepts EITHER the legacy `limit_usd` (USD-direct, no FX) OR
// the multi-currency pair `amount` + `currency`. The route converts the
// pair to USD via lib/fx.toUsd AT SAVE TIME, so the DB always stores the
// canonical USD value the guard enforces against.
const PutSchema = z
  .object({
    period: z.enum(['daily', 'monthly']),
    hard_cap: z.boolean().optional(),
    limit_usd: z.number().min(0).max(100_000).optional(),
    amount: z.number().min(0).max(100_000_000).optional(),
    currency: z.string().trim().min(3).max(3).optional(),
  })
  .refine((v) => v.limit_usd != null || v.amount != null, {
    message: 'Either limit_usd or { amount, currency } is required',
  });

const DeleteSchema = z.object({
  period: z.enum(['daily', 'monthly']),
});

const HARD_CAP_USD = 100_000;

export async function PUT(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }

  // --- Resolve final (limit_usd, display_currency) -----------------------
  let limitUsd: number;
  let displayCurrency: string;

  if (parsed.data.amount != null) {
    const ccy = (parsed.data.currency ?? 'USD').toUpperCase();
    if (!isSupportedCurrency(ccy)) {
      return NextResponse.json(
        { error: 'unsupported currency: ' + ccy },
        { status: 400 },
      );
    }
    try {
      limitUsd = await toUsd(parsed.data.amount, ccy);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fx_failed';
      return NextResponse.json(
        { error: 'currency conversion failed: ' + msg },
        { status: 502 },
      );
    }
    displayCurrency = ccy;
  } else {
    limitUsd = parsed.data.limit_usd ?? 0;
    displayCurrency = 'USD';
  }

  // Safety: after FX, the limit must still be within the canonical cap.
  if (!Number.isFinite(limitUsd) || limitUsd < 0 || limitUsd > HARD_CAP_USD) {
    return NextResponse.json(
      {
        error:
          'converted limit ($' +
          limitUsd.toFixed(2) +
          ') is outside the allowed range [0, $' +
          HARD_CAP_USD +
          ']',
      },
      { status: 400 },
    );
  }

  const supabase = getServerSupabase();
  const budget = await upsertBudget(
    {
      userId: user.id,
      period: parsed.data.period,
      limitUsd,
      hardCap: parsed.data.hard_cap ?? true,
      displayCurrency,
    },
    supabase,
  );
  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'budget.set',
    actor: 'user',
    detail: {
      user_id: user.id,
      period: parsed.data.period,
      limit_usd: limitUsd,
      display_currency: displayCurrency,
      // The amount the user actually typed — useful audit trail when the
      // user picks INR and we store USD.
      entered_amount: parsed.data.amount ?? parsed.data.limit_usd ?? null,
      hard_cap: parsed.data.hard_cap ?? true,
    },
  });
  return NextResponse.json({ budget });
}

export async function DELETE(req: Request) {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid body' },
      { status: 400 },
    );
  }
  const supabase = getServerSupabase();
  await deleteBudget({ userId: user.id, period: parsed.data.period }, supabase);
  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'budget.set',
    actor: 'user',
    detail: { user_id: user.id, period: parsed.data.period, deleted: true },
  });
  return NextResponse.json({ ok: true });
}
