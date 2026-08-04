import type { Plugin, ViteUserConfig } from "vitest/config";
import { type ArchivedSnapshot, resolveOutDir, writeSnapshot } from "@uiverify/archive-core";
import { graphReporter } from "./graph-reporter";
import type { UiverifyPluginOptions } from "./options";

/** The setup file is referenced by its package specifier (not an absolute path) so Vite resolves it
 *  through node_modules and serves it to the browser; an absolute path outside the project root is
 *  blocked by Vite's filesystem allow-list. */
const SETUP_MODULE = "@uiverify/vitest/browser-setup";

/**
 * `uiverifyPlugin()` — the Node side of @uiverify/vitest. Added to `plugins` in a Vitest config, it wires
 * capture into a browser-mode run with no per-test code:
 *
 *  - injects the setup file that auto-snapshots each test (`browser-setup`),
 *  - registers the `__uiverifyWriteSnapshot` browser command that writes each snapshot to disk (the
 *    browser has no filesystem, so the in-page capture hands the assembled snapshot to this Node command),
 *  - passes the global `disableAutoSnapshot` option through to the setup file via provide/inject.
 *
 * The archive lands in the same `./uiverify-archive` directory the `uiverify` CLI uploads.
 */
declare module "vitest" {
  interface ProvidedContext {
    __uiverify: { disableAutoSnapshot: boolean };
  }
}

export function uiverifyPlugin(options: UiverifyPluginOptions = {}): Plugin {
  const outDir = options.outDir ?? resolveOutDir();

  const config: ViteUserConfig = {
    // The capture state (`currentTask`) lives in module scope in `runtime.ts`, shared between the setup
    // file's hooks and the user's `takeSnapshot` import. Dep pre-bundling would give those two entry
    // points separate copies of that module, so `takeSnapshot()` would not see the running test and throw
    // "called outside a test". Excluding the package from optimize keeps everyone on one instance, so a
    // plain `plugins: [uiverifyPlugin()]` works without the user hand-adding this to their config.
    optimizeDeps: { exclude: ["@uiverify/vitest"] },
    test: {
      setupFiles: [SETUP_MODULE],
      // Emit Vite's module graph as `preview-stats.json` so `uiverify upload --only-changed` can skip
      // unchanged snapshots. `"default"` is kept so the plugin doesn't silence Vitest's own output. If a
      // user's own `reporters` config ends up displacing this, the only effect is that no graph ships and
      // the server safely renders everything — add `graphReporter()` back to keep the skip savings.
      reporters: ["default", graphReporter(outDir)],
      provide: { __uiverify: { disableAutoSnapshot: options.disableAutoSnapshot ?? false } },
      browser: {
        commands: {
          __uiverifyWriteSnapshot: async (_ctx: unknown, snapshot: ArchivedSnapshot) => {
            writeSnapshot(outDir, snapshot);
          },
        },
      },
    },
  };

  return {
    name: "uiverify",
    config: () => config,
  };
}
