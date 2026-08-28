import { page } from "@vitest/browser/context";
import { takeSnapshot } from "@uiverify/vitest";
import { expect, test } from "vitest";
import { ProductCard } from "@/components/ProductCard";
import { getProduct } from "@/lib/products";
import { renderScene } from "@/test/harness";

const mug = getProduct("sunrise-mug");
const headphones = getProduct("halo-headphones");
if (!mug || !headphones) throw new Error("expected demo products in the catalog");

// Interaction + screenshot: toggling the wishlist heart flips its pressed state, then the filled state
// is archived.
test("ProductCard wishlist toggles and archives the filled state", async () => {
  renderScene(
    <div style={{ width: 280 }}>
      <ProductCard product={mug} />
    </div>,
  );
  const wish = page.getByRole("button", { name: "Save to wishlist" });
  await expect.element(wish).toHaveAttribute("aria-pressed", "false");
  await wish.click();
  await expect.element(wish).toHaveAttribute("aria-pressed", "true");
  await takeSnapshot();
});

// Screenshot: the sale variant, with its struck compare-at price and diagonal ribbon.
test("ProductCard sale variant", async () => {
  renderScene(
    <div style={{ width: 280 }}>
      <ProductCard product={headphones} />
    </div>,
  );
  await expect.element(page.getByText("Halo Headphones")).toBeVisible();
  await takeSnapshot();
});
