import { expect } from "@uiverify/bun";
import { visualSuite } from "./fixtures";

const { describe, test } = visualSuite(import.meta.path);

/** Every screen of the app, each snapshotted when its test ends (at both of the suite's viewports). */
const SCREENS = [
  { name: "storefront", path: "/", heading: "Well-made things" },
  { name: "product", path: "/product/sunrise-mug", heading: "Sunrise Mug" },
  { name: "sign-in", path: "/login", heading: "Welcome back" },
  { name: "cart-empty", path: "/cart", heading: "Your cart is empty" },
  { name: "order-confirmed", path: "/success", heading: "Thank you, Alex!" },
];

describe("Screens", () => {
  for (const { name, path, heading } of SCREENS) {
    test(name, async (page) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    });
  }
});
