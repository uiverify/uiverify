import { suite } from "../../fixtures";

const { test } = suite(import.meta.path);

test("same", async (page) => {
  await page.goto("/");
});
