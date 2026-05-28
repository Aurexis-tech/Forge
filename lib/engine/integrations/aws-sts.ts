// AWS STS GetCallerIdentity — the ONE call the cloud-connection
// verify path makes. Read-only, free, returns the account id + ARN +
// caller user id of whoever signs the request. The Forge uses this
// as a "do these credentials work at all?" probe before persisting
// them, and as the test-connection check afterwards.
//
// SECURITY:
//   - The secretAccessKey is used ONLY to compute the request
//     signature and to populate the Authorization header. It is
//     NEVER logged. The function nulls the in-scope reference as
//     soon as the signed request is built.
//   - The XML response carries ONLY the account id + ARN + user id —
//     none of those are secrets.
//   - Errors are mapped by status; the raw key is never reflected
//     in the message text.
//
// Why hand-roll SigV4 instead of pulling @aws-sdk/client-sts:
//   - One call, one fixed shape — the SDK adds ~10 MB of dependencies
//     to verify a 1-call read-only API.
//   - The verify path is exercised in tests by stubbing this MODULE
//     directly (vi.mock), so the production code stays narrow.

import { createHash, createHmac } from 'node:crypto';
import { withRetry } from '../retry';

export class AwsStsError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number }) {
    super(message);
    this.name = 'AwsStsError';
    this.status = opts?.status;
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface AwsCallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

/**
 * Calls AWS STS GetCallerIdentity. Returns the caller's identity on
 * success; throws AwsStsError with a status code on failure.
 *
 * The endpoint is the regional STS endpoint (sts.<region>.amazonaws.com).
 * GetCallerIdentity is free and works regardless of any IAM policy —
 * which is exactly why we use it as the verify probe.
 */
export async function stsGetCallerIdentity(
  creds: AwsCredentials,
): Promise<AwsCallerIdentity> {
  const host = 'sts.' + creds.region + '.amazonaws.com';
  const endpoint = 'https://' + host + '/';
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    'x-amz-date': amzDate,
  };

  const signed = signRequest({
    method: 'POST',
    host,
    canonicalUri: '/',
    canonicalQuery: '',
    headers,
    body,
    region: creds.region,
    service: 'sts',
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    amzDate,
    dateStamp,
  });

  // We allow the secret to fall out of scope as soon as the
  // Authorization header is computed.
  const authHeader = signed;

  // Retry transient AWS STS blips (5xx, 429, network). The
  // classifier marks AbortError + 'fetch failed' + 5xx-mentioning
  // errors as retriable. 401/403 (bad creds) and other 4xx are
  // non-retriable, so the loop exits on the first attempt.
  let res: Response;
  try {
    res = await withRetry(
      () =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            ...headers,
            accept: 'application/xml',
            authorization: authHeader,
          },
          body,
        }),
      { maxAttempts: 3, baseDelayMs: 500 },
    );
  } catch (err) {
    throw new AwsStsError(
      'AWS STS request failed: ' +
        (err instanceof Error ? err.message : 'network error'),
    );
  }

  if (!res.ok) {
    const status = res.status;
    if (status === 403 || status === 401) {
      // Most common — bad keys, revoked user, or insufficient perms.
      // STS returns 403 for an unsigned/mis-signed request.
      throw new AwsStsError(
        'cloud credentials rejected by AWS STS (invalid, revoked, or insufficient permission)',
        { status },
      );
    }
    throw new AwsStsError(
      'AWS STS request failed (HTTP ' + status + ')',
      { status },
    );
  }

  const xml = await res.text();
  return parseStsIdentityXml(xml);
}

// ---------------------------------------------------------------------------
// SigV4 signing — bounded to one method (POST), one service (sts), one
// host header set. The general AWS signer is much larger; this is the
// narrow slice we need.
// ---------------------------------------------------------------------------

interface SignRequestInput {
  method: 'POST';
  host: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
  dateStamp: string;
}

function signRequest(input: SignRequestInput): string {
  const sortedHeaderKeys = Object.keys(input.headers).sort();
  const canonicalHeaders =
    sortedHeaderKeys
      .map((k) => k + ':' + input.headers[k]!.trim() + '\n')
      .join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const payloadHash = createHash('sha256').update(input.body).digest('hex');
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope =
    input.dateStamp + '/' + input.region + '/' + input.service + '/aws4_request';
  const canonicalHash = createHash('sha256')
    .update(canonicalRequest)
    .digest('hex');
  const stringToSign = [
    algorithm,
    input.amzDate,
    credentialScope,
    canonicalHash,
  ].join('\n');

  const kDate = hmac('AWS4' + input.secretAccessKey, input.dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return (
    algorithm +
    ' Credential=' +
    input.accessKeyId +
    '/' +
    credentialScope +
    ', SignedHeaders=' +
    signedHeaders +
    ', Signature=' +
    signature
  );
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function formatAmzDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[:-]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// XML parser — STS's response is bounded + stable. Extract the three
// fields we care about with simple regex; nothing else is meaningful.
// ---------------------------------------------------------------------------

function parseStsIdentityXml(xml: string): AwsCallerIdentity {
  const accountId = extract(xml, 'Account');
  const arn = extract(xml, 'Arn');
  const userId = extract(xml, 'UserId');
  if (!accountId || !arn || !userId) {
    throw new AwsStsError(
      'AWS STS returned a response missing identity fields',
    );
  }
  return { accountId, arn, userId };
}

function extract(xml: string, tag: string): string | null {
  const match = new RegExp(
    '<' + tag + '>([^<]+)</' + tag + '>',
  ).exec(xml);
  return match ? match[1] ?? null : null;
}
