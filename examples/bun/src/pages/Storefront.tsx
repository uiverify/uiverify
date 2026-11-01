import { useState } from "react";
import { Link } from "react-router-dom";
import { useCart } from "@/cart/CartContext";
import { Icon } from "@/components/Icon";
import { ProductArt } from "@/components/ProductArt";
import { ProductCard } from "@/components/ProductCard";
import { PRODUCTS, type Category } from "@/lib/products";

const CATEGORIES: { key: Category | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "home", label: "Home" },
  { key: "desk", label: "Desk" },
  { key: "kitchen", label: "Kitchen" },
  { key: "carry", label: "Carry" },
  { key: "sound", label: "Sound" },
];

export function Storefront() {
  const { add } = useCart();
  const [category, setCategory] = useState<Category | "all">("all");
  const products = category === "all" ? PRODUCTS : PRODUCTS.filter((p) => p.category === category);

  return (
    <main className="wrap">
      <section className="hero">
        <div className="inner">
          <div className="copy">
            <span className="tag tag-coral">
              <Icon name="i-sparkle" size={13} /> Spring drop is live
            </span>
            <h1>
              Well-made things
              <br />
              for <em>everyday</em> joy.
            </h1>
            <p>Thoughtfully designed objects for your home, desk, and daily carry. Free shipping over $50, always.</p>
            <div className="cta">
              <Link className="btn btn-primary btn-lg" to="/product/sunrise-mug">
                Shop the drop <Icon name="i-arrow" />
              </Link>
              <Link className="btn btn-ghost btn-lg" to="/">
                Browse all
              </Link>
            </div>
          </div>
          <div className="stage">
            <ProductArt glyph="plant" gradient="g-plant" className="float f1" />
            <ProductArt glyph="speaker" gradient="g-speaker" className="float f2" />
            <ProductArt glyph="mug" gradient="g-mug" className="float f3" />
            <div className="chip" style={{ left: 6, bottom: 92 }}>
              <span className="k" style={{ background: "var(--mint)" }}>
                <Icon name="i-check" />
              </span>{" "}
              4.9 / 5 · 2,300 reviews
            </div>
            <div className="chip" style={{ right: 6, bottom: 44 }}>
              <span className="k" style={{ background: "var(--coral)" }}>
                <Icon name="i-refresh" />
              </span>{" "}
              Free 30-day returns
            </div>
          </div>
        </div>
      </section>

      <div className="values">
        <div className="value">
          <span className="vi">
            <Icon name="i-truck" />
          </span>
          <div>
            <b>Free shipping</b>
            <span>On every order over $50</span>
          </div>
        </div>
        <div className="value">
          <span className="vi">
            <Icon name="i-refresh" />
          </span>
          <div>
            <b>30-day returns</b>
            <span>No questions asked</span>
          </div>
        </div>
        <div className="value">
          <span className="vi">
            <Icon name="i-shield" />
          </span>
          <div>
            <b>2-year warranty</b>
            <span>We stand behind it</span>
          </div>
        </div>
      </div>

      <div className="cats">
        {CATEGORIES.map((c) => (
          <button key={c.key} className={`pill ${c.key === category ? "active" : ""}`.trim()} onClick={() => setCategory(c.key)}>
            {c.label}
          </button>
        ))}
      </div>

      <section className="section" style={{ paddingBottom: 8 }}>
        <div className="section-head">
          <div>
            <span className="eyebrow">Trending now</span>
            <h2 className="h2" style={{ marginTop: 10 }}>
              Loved by the community
            </h2>
          </div>
          <Link to="/">
            View all <Icon name="i-arrow" />
          </Link>
        </div>

        <div className="grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} onAdd={add} />
          ))}
        </div>

        <div className="bento">
          <div className="bcard a">
            <ProductArt glyph="speaker" gradient="g-speaker" className="float" />
            <h3>Sound, softened.</h3>
            <p>Speakers and headphones tuned for warm, room-filling sound.</p>
            <Link className="go" to="/">
              Shop Sound <Icon name="i-arrow" />
            </Link>
          </div>
          <div className="bcard b">
            <ProductArt glyph="plant" gradient="g-plant" className="float" />
            <h3>For the home</h3>
            <p>Planters, lamps and candles to make any room yours.</p>
            <Link className="go" to="/">
              Shop Home <Icon name="i-arrow" />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
