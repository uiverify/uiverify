import { Icon } from "./Icon";

/** Compact one-star rating used on product cards: a star glyph and the numeric score. */
export function Rating({ value }: { value: number }) {
  return (
    <span className="rating">
      <Icon name="i-star" /> {value.toFixed(1)}
    </span>
  );
}

/** Full five-star row with the score and review count, used on the product detail page. */
export function Stars({ value, reviews }: { value: number; reviews: number }) {
  return (
    <span className="stars">
      {Array.from({ length: 5 }, (_, i) => (
        <Icon key={i} name="i-star" />
      ))}
      <span className="n">
        {value.toFixed(1)} ({reviews})
      </span>
    </span>
  );
}
