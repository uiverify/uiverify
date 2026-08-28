import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCart } from "@/cart/CartContext";
import { Icon } from "@/components/Icon";
import { ProductArt } from "@/components/ProductArt";
import { QuantityStepper } from "@/components/QuantityStepper";
import { FREE_SHIPPING_THRESHOLD } from "@/lib/cart";
import { formatPrice } from "@/lib/format";

export function Cart() {
  const { items, count, totals, promoApplied, setQuantity, remove, applyPromo } = useCart();
  const [promo, setPromo] = useState("SPRING15");
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <main className="wrap">
        <div className="empty-cart">
          <div className="ei">
            <Icon name="i-cart" />
          </div>
          <h2>Your cart is empty</h2>
          <p>Once you add something, it will show up here.</p>
          <Link className="btn btn-primary btn-lg" to="/">
            Start shopping
          </Link>
        </div>
      </main>
    );
  }

  const toGo = FREE_SHIPPING_THRESHOLD - totals.subtotal;
  const itemWord = count === 1 ? "item" : "items";
  const sub =
    toGo > 0
      ? `${count} ${itemWord} · you're ${formatPrice(toGo)} away from free shipping.`
      : `${count} ${itemWord} · you qualify for free shipping.`;

  return (
    <main className="wrap">
      <h1 className="page-title">Your cart</h1>
      <p className="page-sub">{sub}</p>

      <div className="checkout">
        <div className="lines">
          {items.map((item) => (
            <div className="line" key={item.key}>
              <ProductArt glyph={item.glyph} gradient={item.gradient} />
              <div className="meta">
                <h3>{item.name}</h3>
                <p>{[item.color, item.size].filter(Boolean).join(" · ")}</p>
              </div>
              <QuantityStepper value={item.qty} onChange={(q) => setQuantity(item.key, q)} />
              <span className="lp">{formatPrice(item.price * item.qty)}</span>
              <button className="rm" aria-label={`Remove ${item.name}`} onClick={() => remove(item.key)}>
                <Icon name="i-x" />
              </button>
            </div>
          ))}
          <Link to="/" className="btn btn-ghost" style={{ alignSelf: "flex-start", marginTop: 6 }}>
            <svg style={{ transform: "rotate(180deg)", width: 18, height: 18 }} aria-hidden="true">
              <use href="#i-arrow" />
            </svg>{" "}
            Continue shopping
          </Link>
        </div>

        <aside className="summary">
          <h2>Order summary</h2>
          <div className="srow">
            <span>Subtotal</span>
            <b>{formatPrice(totals.subtotal)}</b>
          </div>
          <div className="srow">
            <span>Shipping</span>
            <b>{totals.shipping === 0 ? "Free" : formatPrice(totals.shipping)}</b>
          </div>
          <div className="srow">
            <span>Tax</span>
            <b>{formatPrice(totals.tax)}</b>
          </div>

          <div className="promo-row">
            <input aria-label="Promo code" value={promo} onChange={(e) => setPromo(e.target.value)} />
            <button className="btn btn-ghost" onClick={() => applyPromo(promo)}>
              Apply
            </button>
          </div>
          {promoApplied && (
            <div className="applied">
              <span>
                <Icon name="i-check" /> SPRING15 applied
              </span>
              <span>−{formatPrice(totals.discount)}</span>
            </div>
          )}

          <div className="srow total">
            <span>Total</span>
            <b>{formatPrice(totals.total)}</b>
          </div>

          <button className="btn btn-primary btn-block btn-lg" style={{ marginTop: 18 }} onClick={() => navigate("/success")}>
            Checkout · {formatPrice(totals.total)}
          </button>
          <div className="safe">
            <Icon name="i-lock" /> Secure checkout · encrypted
          </div>
        </aside>
      </div>
    </main>
  );
}
