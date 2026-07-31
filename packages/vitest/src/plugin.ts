import type { Plugin, ViteUserConfig } from "vitest/config";
import { type ArchivedSnapshot, resolveOutDir, writeSnapshot } from "@uiverify/archive-core";
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
    test: {
      setupFiles: [SETUP_MODULE],
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
