// Cloud credentials connect route. Mirrors /api/connections/github/pat
// in shape (encrypted at rest, verified before persist, never logged,
// never returned). Stores the cloud creds as ONE encrypted blob — a
// JSON env bag {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION}
// — which is what lib/engine/infra/cloud/connection.ts already
// expects when the P4-5a plan / P4-5b apply paths decrypt it.
//
// Test-connection is a CHEAP, READ-ONLY identity check: AWS STS
// GetCallerIdentity. It returns the caller's account id + ARN and
// MUST NEVER create / modify / cost anything. The verify on this
// /pat route uses the same call, so a hostile typo is caught BEFORE
// we persist.
//
// SECURITY:
//   - Body fields (access key id + secret + region) arrive over HTTPS,
//     never in the URL.
//   - The secret-access-key is NEVER logged. The audit log records
//     only the account id + ARN returned by STS.
//   - The response contains identity metadata only — never the keys.
//   - The credential bundle is encrypted at rest via lib/crypto's
//     AES-256-GCM before any DB row carries it.
//
// ⚠️ STRONG GUIDANCE (rendered prominently in the UI panel):
//   - Use a DEDICATED, LEAST-PRIVILEGE IAM USER — not root account
//     keys. The Forge's catalog targets a bounded set of AWS
//     resources; an IAM user with only the policies it needs is the
//     correct profile.
//   - Set an AWS Budget + billing alarm as a backstop. The Forge's
//     in-app cost ceiling fires BEFORE apply; an AWS-side budget is
//     the second line of defence.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { upsertConnection } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';
import { stsGetCallerIdentity } from '@/lib/engine/integrations/aws-sts';

export const runtime = 'nodejs';

const BodySchema = z.object({
  // AWS-shaped. The connection.ts loader accepts ANY env-bag where
  // keys match /^[A-Z][A-Z0-9_]*$/, but P4-5a currently only spawns
  // a terraform process that consumes AWS_*. Other providers land
  // as a deliberate future extension.
  AWS_ACCESS_KEY_ID: z
    .string()
    .trim()
    .min(16)
    .max(128)
    .regex(/^[A-Z0-9]+$/, 'AWS_ACCESS_KEY_ID must be uppercase alphanumerics'),
  AWS_SECRET_ACCESS_KEY: z.string().trim().min(16).max(256),
  AWS_REGION: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'AWS_REGION must be lower-case region slug'),
});

export async function POST(req: Request) {
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
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          'cloud credentials require AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION',
      },
      { status: 400 },
    );
  }
  const creds = parsed.data;

  // Verify with AWS STS GetCallerIdentity — read-only, ~free, returns
  // the account id + ARN. If it 4xxs, the keys are bad and we never
  // persist them.
  let identity;
  try {
    identity = await stsGetCallerIdentity({
      accessKeyId: creds.AWS_ACCESS_KEY_ID,
      secretAccessKey: creds.AWS_SECRET_ACCESS_KEY,
      region: creds.AWS_REGION,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'cloud verification failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // The stored 'token' for the 'cloud' connection is a JSON-serialised
  // env bag — exactly what lib/engine/infra/cloud/connection.ts
  // parses on decrypt.
  const envBag = JSON.stringify({
    AWS_ACCESS_KEY_ID: creds.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: creds.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: creds.AWS_REGION,
  });

  // accountLogin = a non-secret identifier surfaced in the UI +
  // audit. STS gave us the account id; we combine with region to
  // make it scannable ("aws-123456789012-us-east-1").
  const accountLogin =
    'aws-' + identity.accountId + '-' + creds.AWS_REGION;

  const supabase = getServerSupabase();
  try {
    await upsertConnection(supabase, {
      provider: 'cloud',
      accountLogin,
      token: envBag,
      // Surfaced as a hint string in the UI. The ARN is NOT a secret.
      scopes: identity.arn,
      userId: user.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'persist_failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Audit — record the public identity returned by STS. NEVER the
  // access key or secret-access-key.
  await supabase.from('audit_log').insert({
    project_id: null,
    action: 'connection.cloud_linked',
    actor: 'user',
    detail: {
      account_login: accountLogin,
      aws_account_id: identity.accountId,
      aws_caller_arn: identity.arn,
      aws_region: creds.AWS_REGION,
      auth_method: 'iam-user',
      user_id: user.id,
    },
  });

  return NextResponse.json({
    status: 'connected',
    provider: 'cloud',
    account_login: accountLogin,
    aws_account_id: identity.accountId,
    aws_caller_arn: identity.arn,
    aws_region: creds.AWS_REGION,
  });
}
