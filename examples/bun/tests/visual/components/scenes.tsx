import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { Button } from "@/components/Button";
import { ProductCard } from "@/components/ProductCard";
import { QuantityStepper } from "@/components/QuantityStepper";
import { Sprite } from "@/components/Sprite";
import { getProduct } from "@/lib/products";
import "@/fonts";
import "@/index.css";

const mug = getProduct("sunrise-mug");
const headphones = getProduct("halo-headphones");
if (!mug || !headphones) throw new Error("expected demo products in the catalog");

function Stepper() {
  const [value, setValue] = useState(1);
  return <QuantityStepper value={value} onChange={setValue} />;
}

/** The component page the tests open: `/?scene=<name>` renders one scene, in isolation. */
const SCENES: Record<string, ReactNode> = {
  buttons: (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button variant="primary">Add to cart</Button>
      <Button variant="ghost">Browse all</Button>
      <Button variant="dark">Checkout</Button>
      <Button variant="primary" disabled>
        Sold out
      </Button>
    </div>
  ),
  "product-cards": (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 280px)", gap: 22 }}>
      <ProductCard product={mug} />
      <ProductCard product={headphones} />
    </div>
  ),
  "quantity-stepper": <Stepper />,
};

const scene = new URLSearchParams(location.search).get("scene") ?? "";
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <div style={{ background: "var(--cream)", padding: 40 }}>
      <Sprite />
      <MemoryRouter>{SCENES[scene] ?? <p>Unknown scene: {scene}</p>}</MemoryRouter>
    </div>
  </StrictMode>,
);
