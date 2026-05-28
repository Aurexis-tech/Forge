// Verify a previously-stored cloud connection without re-pasting it.
// Decrypts the stored env bag, parses out the AWS creds, runs AWS
// STS GetCallerIdentity (READ-ONLY, ~free), reports pass/fail + the
// caller's account id + ARN.
//
// MUST NEVER create / modify / cost anything. STS GetCallerIdentity
// is the cheapest read-only AWS call — it exists for exactly this
// "does this credential work?" purpose.
//
// SECURITY: the decrypted env bag NEVER leaves this handler. The
// response only contains the account id + ARN (non-secrets).

import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth';
import { loadInfraCloudConnection } from '@/lib/engine/infra/cloud/connection';
import { stsGetCallerIdentity, AwsStsError } from '@/lib/engine/integrations/aws-sts';
import { getServerSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST() {
  let user;
  try {
    user = await requireUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
    throw err;
  }

  const supabase = getServerSupabase();
  const loaded = await loadInfraCloudConnection(supabase, user.id);
  if (!loaded) {
    return NextResponse.json(
      { ok: false, error: 'no cloud connection' },
      { status: 404 },
    );
  }

  const accessKeyId = loaded.envFromToken.AWS_ACCESS_KEY_ID;
  const secretAccessKey = loaded.envFromToken.AWS_SECRET_ACCESS_KEY;
  const region = loaded.envFromToken.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) {
    return NextResponse.json(
      {
        ok: false,
        provider: 'cloud',
        error:
          'stored cloud connection is missing AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION — re-connect',
      },
      { status: 200 },
    );
  }

  try {
    const identity = await stsGetCallerIdentity({
      accessKeyId,
      secretAccessKey,
      region,
    });

    // Keep the stored account_login fresh in case the user rotated
    // creds to a different account. Never touches the encrypted blob.
    const accountLogin = 'aws-' + identity.accountId + '-' + region;
    await supabase
      .from('connections')
      .update({
        account_login: accountLogin,
        scopes: identity.arn,
      })
      .eq('user_id', user.id)
      .eq('provider', 'cloud');

    return NextResponse.json({
      ok: true,
      provider: 'cloud',
      account_login: accountLogin,
      aws_account_id: identity.accountId,
      aws_caller_arn: identity.arn,
      aws_region: region,
    });
  } catch (err) {
    const message =
      err instanceof AwsStsError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'cloud verification failed';
    return NextResponse.json(
      { ok: false, provider: 'cloud', error: message },
      { status: 200 },
    );
  }
}
