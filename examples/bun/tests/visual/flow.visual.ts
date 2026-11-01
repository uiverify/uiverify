import { DEFAULT_VIEWPORT, expect, takeSnapshot } from "@uiverify/bun";
import { visualSuite } from "./fixtures";

const { test } = visualSuite(import.meta.path);

/**
 * The shopping flow, driven end to end: filter the storefront, configure a product (color + size +
 * quantity), add it, and apply a promo in the cart. Each `takeSnapshot(...)` archives the state AFTER the
 * interaction that produced it, so the visual diff sees exactly what the shopper sees.
 */
test(
  "shop flow: filter, configure, add to cart, apply promo",
  async (page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sound", exact: true }).click();
    await expect(page.getByRole("link", { name: "Pocket Speaker" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sunrise Mug" })).toHaveCount(0);
    await takeSnapshot("storefront-filtered-sound");

    await page.goto("/product/sunrise-mug");
    await page.getByRole("button", { name: "View Fern" }).click();
    await page.getByRole("button", { name: "16oz", exact: true }).click();
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByRole("button", { name: /Add to cart · \$48/ })).toBeVisible();
    await takeSnapshot("product-configured");

    await page.getByRole("button", { name: /Add to cart/ }).click();
    await expect(page.getByRole("link", { name: "Cart, 2 items" })).toBeVisible();
    // The "added to cart" toast hides itself on a timer: wait it out, or whether it is in the next
    // snapshot depends on how fast the steps below run.
    await expect(page.getByRole("status")).not.toBeVisible();

    await page.getByRole("link", { name: "Cart, 2 items" }).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("SPRING15 applied")).toBeVisible();
    await takeSnapshot("cart-with-promo");
  },
  { viewports: { "": DEFAULT_VIEWPORT } },
);
