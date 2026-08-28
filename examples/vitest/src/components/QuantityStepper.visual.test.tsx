import { useState } from "react";
import { page } from "@vitest/browser/context";
import { takeSnapshot } from "@uiverify/vitest";
import { expect, test } from "vitest";
import { QuantityStepper } from "@/components/QuantityStepper";
import { renderScene } from "@/test/harness";

function Demo() {
  const [value, setValue] = useState(1);
  return <QuantityStepper value={value} onChange={setValue} />;
}

// Interaction + screenshot: the stepper starts at its minimum (decrement disabled), increments on click,
// then the post-click state is archived for visual diffing.
test("QuantityStepper increments and archives the result", async () => {
  renderScene(<Demo />);
  await expect.element(page.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
  await page.getByRole("button", { name: "Increase quantity" }).click();
  await page.getByRole("button", { name: "Increase quantity" }).click();
  await expect.element(page.getByText("3")).toBeVisible();
  await takeSnapshot();
});
