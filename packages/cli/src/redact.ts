/**
 * Redact credentials from any string before it reaches the logs.
 *
 * Three layers, because knowing the secret is not something we can rely on. Every secret this run holds
 * (the `UIVERIFY_API_KEY`, a login's tokens and device code, the store key) is registered with `holdSecret`
 * and masked wherever it appears, as is the extra `secret` a caller passes. But a credential
 * can reach a log string by routes the caller never sees — typed onto the command line by someone who
 * missed that it comes from the environment, echoed back inside a server error, quoted in a retry's
 * failure reason — and there the exact value is unknown. So anything *shaped* like a UI Verify key or a
 * JWT is masked too, whatever we happen to know.
 *
 * This matters more than a usual log hygiene rule: the key lives in GitHub Actions secrets, only a repo
 * admin can set or rotate it, and on a public repository the CI log is world-readable. A leak is a
 * credential exposure the person who has to fix it may not even be the one who caused it.
 *
 * The key prefixes mirror the control plane's accepted key formats (`uv_…` current, `vt_live_…` legacy).
 * Like every other contract here they are duplicated deliberately rather than imported — this package
 * has no dependency on the product repo. Over-masking is harmless; under-masking is not, so the
 * patterns err wide.
 */
const API_KEY_PATTERN = /(?:uv_|vt_live_)[A-Za-z0-9_]{6,}/g;
// A JWT's header is base64url JSON, so it always opens with `eyJ` (`{"`); the signature may be empty.
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

// Shorter values would mask ordinary words; every real credential is far longer.
const MIN_HELD_SECRET_LENGTH = 8;
const heldSecrets = new Set<string>();

/** Mask `value` in every string this process redacts from now on. */
export function holdSecret(value: string | undefined): void {
  if (value && value.length >= MIN_HELD_SECRET_LENGTH) heldSecrets.add(value);
}

export function redact(text: string, secret?: string | undefined): string {
  let masked = text;
  for (const s of secret ? [secret, ...heldSecrets] : heldSecrets) masked = masked.split(s).join(maskKey(s));
  return masked.replace(API_KEY_PATTERN, maskKey).replace(JWT_PATTERN, maskKey);
}

export function maskKey(key: string): string {
  const visible = key.slice(0, 8);
  return `${visible}${"*".repeat(Math.max(0, key.length - 8))}`;
}
