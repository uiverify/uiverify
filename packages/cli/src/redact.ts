/**
 * Redact a secret (the project API key) from any string before it reaches the logs (ws6
 * robustness: "redact the key from logs"). Replaces every occurrence with a masked form that
 * keeps only the leading 8-character prefix visible.
 */
export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join(maskKey(secret));
}

export function maskKey(key: string): string {
  const visible = key.slice(0, 8);
  return `${visible}${"*".repeat(Math.max(0, key.length - 8))}`;
}
