/** Money as a compact dollar string: whole amounts drop the cents ("$24"), otherwise two decimals ("$56.08"). */
export function formatPrice(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}
