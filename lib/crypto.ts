// AES-256-GCM encryption for at-rest secrets (currently: third-party OAuth
// tokens in the connections table).
//
// Layout of an encrypted payload (base64-encoded):
//   bytes  0..11   — random 12-byte IV (one per encryption)
//   bytes 12..27   — 16-byte GCM auth tag
//   bytes 28..end  — ciphertext
//
// SECURITY NOTES:
// - The key comes from APP_ENC_KEY (32 raw bytes, base64-encoded).
// - Rotating the key invalidates every existing ciphertext. There is no
//   re-encryption helper yet; if you rotate the key, users must reconnect.
// - This module is server-only. Importing it from a client component will
//   fail at first call because `node:crypto` isn't available in the browser.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function readKey(): Buffer {
  const raw = process.env.APP_ENC_KEY;
  if (!raw) {
    throw new Error(
      '[aurexis-forge] APP_ENC_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      '[aurexis-forge] APP_ENC_KEY must decode to exactly 32 bytes ' +
        '(got ' + key.length + '). Re-generate it as 32 random bytes, base64.',
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = readKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv) as CipherGCM;
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const key = readKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('[aurexis-forge] ciphertext payload is truncated');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// Constant-time string compare for OAuth state validation. Lengths must
// match; we pad-and-fail to avoid leaking length through timing.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
