import { page } from "@vitest/browser/context";
import { takeSnapshot } from "@uiverify/vitest";
import { expect, test } from "vitest";
import { Button } from "@/components/Button";
import { renderScene } from "@/test/harness";

// Screenshot: every button variant side by side, so a token/style change to any is caught.
test("Button variants", async () => {
  renderScene(
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button variant="primary">Add to cart</Button>
      <Button variant="ghost">Browse all</Button>
      <Button variant="dark">Checkout</Button>
      <Button variant="primary" disabled>
        Sold out
      </Button>
    </div>,
  );
  await expect.element(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
  await takeSnapshot();
});
