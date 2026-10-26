import { afterAll } from "bun:test";
import { expect, serveBundle } from "../../dist/index.js";
import { suite } from "./fixtures";

const preview = await serveBundle({
  entrypoint: new URL("./preview/index.html", import.meta.url).pathname,
  define: { "process.env.GREETING": '"Hello from define"' },
  plugins: [
    {
      name: "virtual-suffix",
      setup(build) {
        build.onResolve({ filter: /^virtual:suffix$/ }, () => ({ path: "suffix", namespace: "virtual" }));
        build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({ contents: 'export const suffix = "and a plugin";', loader: "js" }));
      },
    },
  ],
});
afterAll(() => preview.stop());

const { test } = suite(import.meta.path, { baseUrl: preview.url });

test("a component page", async (page) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hello from define and a plugin" })).toBeVisible();
});
