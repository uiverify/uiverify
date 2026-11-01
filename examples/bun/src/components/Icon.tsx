/** References a symbol from the inlined {@link Sprite} by id (without the "i-"/"p-" prefix rule - pass the
 *  full id, e.g. "i-cart" or "p-mug"). Size comes from CSS (parent selectors) unless `size` is given. */
export function Icon({ name, size, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" focusable="false" style={size ? { width: size, height: size } : undefined}>
      <use href={`#${name}`} />
    </svg>
  );
}
