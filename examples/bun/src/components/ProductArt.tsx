import type { ReactNode } from "react";

/** A product illustration tile: a gradient background with the soft-white SVG glyph centered on it.
 *  `gradient` is a "g-*" class; `glyph` is a product sprite id without the "p-" prefix. Overlays
 *  (ribbon, wishlist button) are passed as children. */
export function ProductArt({
  glyph,
  gradient,
  className = "",
  children,
}: {
  glyph: string;
  gradient: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`art ${gradient} ${className}`.trim()}>
      {children}
      <svg className="pi" aria-hidden="true" focusable="false">
        <use href={`#p-${glyph}`} />
      </svg>
    </div>
  );
}
