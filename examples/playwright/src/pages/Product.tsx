import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useCart } from "@/cart/CartContext";
import { Icon } from "@/components/Icon";
import { ProductArt } from "@/components/ProductArt";
import { QuantityStepper } from "@/components/QuantityStepper";
import { Stars } from "@/components/Rating";
import { SizePicker, SwatchPicker } from "@/components/OptionPickers";
import { formatPrice } from "@/lib/format";
import { getProduct } from "@/lib/products";

export function Product() {
  const { id = "" } = useParams();
  const product = getProduct(id);
  const { add } = useCart();

  const [color, setColor] = useState(product?.colors[0]?.name ?? "");
  const [size, setSize] = useState(product?.sizes?.[Math.min(1, (product.sizes.length ?? 1) - 1)] ?? "");
  const [qty, setQty] = useState(1);

  if (!product) return <Navigate to="/" replace />;

  const activeColor = product.colors.find((c) => c.name === color) ?? product.colors[0];
  const mainGradient = activeColor?.cls ?? product.gradient;

  return (
    <main className="wrap">
      <p className="crumbs">
        <Link to="/">Shop</Link> / <Link to="/">{product.category[0].toUpperCase() + product.category.slice(1)}</Link> /{" "}
        <span style={{ color: "var(--ink)" }}>{product.name}</span>
      </p>

      <div className="pdp">
        <div className="gallery">
          <ProductArt glyph={product.glyph} gradient={mainGradient} className="main">
            {product.ribbon && <span className="ribbon">{product.ribbon}</span>}
          </ProductArt>
          <div className="thumbs">
            {product.colors.map((c) => (
              <button
                key={c.name}
                type="button"
                aria-label={`View ${c.name}`}
                aria-pressed={c.name === color}
                className={`art ${c.cls} thumb ${c.name === color ? "active" : ""}`.trim()}
                onClick={() => setColor(c.name)}
              >
                <svg className="pi" aria-hidden="true" focusable="false">
                  <use href={`#p-${product.glyph}`} />
                </svg>
              </button>
            ))}
          </div>
        </div>

        <div className="info">
          {product.badge && (
            <span className={`tag tag-${product.badge.tone}`}>
              <Icon name="i-sparkle" size={13} /> {product.badge.label}
            </span>
          )}
          <h1>{product.name}</h1>
          <div className="priceline">
            <span className="p">{formatPrice(product.price)}</span>
            <Stars value={product.rating} reviews={product.reviews} />
          </div>
          <p className="desc">{product.description}</p>

          <p className="opt-label">Color — {color}</p>
          <SwatchPicker colors={product.colors} value={color} onChange={setColor} />

          {product.sizes && (
            <>
              <p className="opt-label">Size</p>
              <SizePicker sizes={product.sizes} value={size} onChange={setSize} />
            </>
          )}

          <div className="buy">
            <QuantityStepper value={qty} onChange={setQty} />
            <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={() => add(product, { color, size, qty })}>
              Add to cart · {formatPrice(product.price * qty)}
            </button>
            <button className="icon-btn" style={{ width: 54, height: 54, borderRadius: 16 }} aria-label="Save to wishlist">
              <Icon name="i-heart" />
            </button>
          </div>

          <div className="trust">
            <div>
              <span className="ico">
                <Icon name="i-truck" />
              </span>{" "}
              Free shipping over $50
            </div>
            <div>
              <span className="ico">
                <Icon name="i-refresh" />
              </span>{" "}
              30-day returns
            </div>
            <div>
              <span className="ico">
                <Icon name="i-check" />
              </span>{" "}
              In stock, ships today
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
