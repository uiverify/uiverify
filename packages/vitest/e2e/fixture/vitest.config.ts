import path from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { uiverifyPlugin } from "../../dist/plugin.js";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");

// The built SDK, inside one entry of a `projects` config next to a Node-only project: Vitest ignores a
// project's own `reporters`, so the plugin has to add the module-graph reporter at the root. The plugin's
// setup file resolves to the build through the package's own name, so the tests' import must too, or the two
// load separate copies of the capture state.
/** A browser project running `include` with the SDK. */
function visualProject(name: string, include: string[]) {
  return {
    plugins: [uiverifyPlugin()],
    resolve: { alias: [{ find: /^@uiverify\/vitest$/, replacement: path.join(dist, "index.js") }] },
    optimizeDeps: { exclude: ["@uiverify/vitest", "@uiverify/vitest/browser-setup"] },
    define: { __ASSETS__: JSON.stringify(process.env.UIVERIFY_E2E_ASSETS ?? "") },
    test: {
      name,
      include,
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        instances: [{ browser: "chromium" }],
        screenshotFailures: false,
      },
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["unit/*.ts"], environment: "node" } },
      visualProject("visual", ["visual/*.capture.ts"]),
      // A second project running a file the first also runs, into the same archive folder.
      ...(process.env.UIVERIFY_E2E_SECOND_PROJECT ? [visualProject("visual-copy", ["visual/ids.capture.ts"])] : []),
    ],
  },
});
