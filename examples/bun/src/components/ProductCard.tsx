import { useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { formatPrice } from "@/lib/format";
import type { Product } from "@/lib/products";
import { Icon } from "./Icon";
import { ProductArt } from "./ProductArt";
import { Rating } from "./Rating";

/** A storefront product card. The whole card links to the product page; the wishlist heart toggles
 *  locally and the "+" adds to cart - both stop propagation so they don't trigger navigation. */
export function ProductCard({ product, onAdd }: { product: Product; onAdd?: (product: Product) => void }) {
  const [wished, setWished] = useState(false);

  const toggleWish = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setWished((w) => !w);
  };

  const add = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAdd?.(product);
  };

  return (
    <Link className="card" to={`/product/${product.id}`} aria-label={product.name}>
      <ProductArt glyph={product.glyph} gradient={product.gradient}>
        {product.ribbon && <span className="ribbon">{product.ribbon}</span>}
        <button className={`wish ${wished ? "on" : ""}`.trim()} aria-label="Save to wishlist" aria-pressed={wished} onClick={toggleWish}>
          <Icon name="i-heart" />
        </button>
      </ProductArt>
      <h3>{product.name}</h3>
      <p className="sub">{product.sub}</p>
      <div className="row">
        <span className="price">
          {formatPrice(product.price)}
          {product.compareAt && <span className="old">{formatPrice(product.compareAt)}</span>}
        </span>
        <Rating value={product.rating} />
      </div>
      <div className="row" style={{ marginTop: 0 }}>
        {product.badge && <span className={`tag tag-${product.badge.tone}`}>{product.badge.label}</span>}
        <button className="add" aria-label={`Add ${product.name} to cart`} onClick={add}>
          <Icon name="i-plus" />
        </button>
      </div>
    </Link>
  );
}
