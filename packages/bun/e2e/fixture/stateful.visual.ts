import { suite } from "./fixtures";

// Runs as two shards with a server each: every test × viewport entry is dealt to the shards in turn.
const { test } = suite(import.meta.path);

test("first", async (page) => void (await page.goto("/")), {
  viewports: { "": { width: 800, height: 600 }, mobile: { width: 390, height: 844 } },
});
test("second", async (page) => void (await page.goto("/")));
test("third", async (page) => void (await page.goto("/")));
