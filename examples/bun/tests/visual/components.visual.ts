import { afterAll } from "bun:test";
import { DEFAULT_VIEWPORT, expect, serveBundle } from "@uiverify/bun";
import { visualSuite } from "./fixtures";

// Components in isolation: Bun builds the component page and serves it at "/", no app server needed.
const preview = await serveBundle({ entrypoint: `${import.meta.dir}/components/index.html` });
afterAll(() => preview.stop());

const { describe, test } = visualSuite(import.meta.path, { baseUrl: preview.url });

describe("Components", { viewports: { "": DEFAULT_VIEWPORT } }, () => {
  test("Button variants", async (page) => {
    await page.goto("/?scene=buttons");
    await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
  });

  // Interaction, then snapshot: the wishlist heart is archived filled.
  test("ProductCard wishlist toggled", async (page) => {
    await page.goto("/?scene=product-cards");
    const wish = page.getByRole("button", { name: "Save to wishlist" }).first();
    await expect(wish).toHaveAttribute("aria-pressed", "false");
    await wish.click();
    await expect(wish).toHaveAttribute("aria-pressed", "true");
  });

  test("QuantityStepper incremented", async (page) => {
    await page.goto("/?scene=quantity-stepper");
    await expect(page.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await page.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByText("3")).toBeVisible();
  });
});
