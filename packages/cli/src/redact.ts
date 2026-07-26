/**
 * Redact the project API key from any string before it reaches the logs.
 *
 * Two layers, because knowing the secret is not something we can rely on. The caller passes the key it
 * read from `UIVERIFY_API_KEY`, and every occurrence of that exact string is masked. But a key can
 * reach a log string by routes the caller never sees — typed onto the command line by someone who
 * missed that it comes from the environment, echoed back inside a server error, quoted in a retry's
 * failure reason — and there the exact value is unknown. So anything *shaped* like a UI Verify key is
 * masked too, whatever we happen to know.
 *
 * This matters more than a usual log hygiene rule: the key lives in GitHub Actions secrets, only a repo
 * admin can set or rotate it, and on a public repository the CI log is world-readable. A leak is a
 * credential exposure the person who has to fix it may not even be the one who caused it.
 *
 * The prefixes mirror the control plane's accepted key formats (`uv_…` current, `vt_live_…` legacy).
 * Like every other contract here they are duplicated deliberately rather than imported — this package
 * has no dependency on the product repo. Over-masking is harmless; under-masking is not, so the
 * pattern errs wide.
 */
const API_KEY_PATTERN = /(?:uv_|vt_live_)[A-Za-z0-9_]{6,}/g;

export function redact(text: string, secret?: string | undefined): string {
  const masked = secret ? text.split(secret).join(maskKey(secret)) : text;
  return masked.replace(API_KEY_PATTERN, maskKey);
}

export function maskKey(key: string): string {
  const visible = key.slice(0, 8);
  return `${visible}${"*".repeat(Math.max(0, key.length - 8))}`;
}
