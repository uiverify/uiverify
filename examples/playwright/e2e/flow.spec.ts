import { expect, test } from "@uiverify/playwright";

/**
 * The shopping flow, driven end to end: filter the storefront, configure a product (color + size +
 * quantity), add it, and apply a promo in the cart. Each `uiVerify.snapshot(...)` archives the state
 * AFTER the interaction that produced it, so the visual diff sees exactly what the shopper sees.
 */
test("shop flow: filter, configure, add to cart, apply promo", async ({ page, uiVerify }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await uiVerify.snapshot("storefront");

  // Filter the grid to the Sound category - a kitchen product should disappear.
  await page.getByRole("button", { name: "Sound", exact: true }).click();
  await expect(page.getByRole("link", { name: "Pocket Speaker" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sunrise Mug" })).toHaveCount(0);
  await uiVerify.snapshot("storefront-filtered-sound");

  // Open a product and configure it: pick the Fern color, the 16oz size, bump quantity to 2.
  await page.goto("/product/sunrise-mug");
  await page.getByRole("button", { name: "View Fern" }).click();
  await page.getByRole("button", { name: "16oz", exact: true }).click();
  await page.getByRole("button", { name: "Increase quantity" }).click();
  await expect(page.getByRole("button", { name: /Add to cart · \$48/ })).toBeVisible();
  await uiVerify.snapshot("product-configured");

  // Add to cart - the header badge reflects the quantity.
  await page.getByRole("button", { name: /Add to cart/ }).click();
  await expect(page.getByRole("link", { name: "Cart, 2 items" })).toBeVisible();

  // In the cart, apply the promo code and see the discount land.
  await page.getByRole("link", { name: "Cart, 2 items" }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("SPRING15 applied")).toBeVisible();
  await uiVerify.snapshot("cart-with-promo");
});
