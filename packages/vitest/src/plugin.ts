import type { Plugin, ViteUserConfig } from "vitest/config";
import { type CapturedSnapshot, resolveOutDir, writeSnapshot } from "@uiverify/archive-core";
import { resolveBrowserApi } from "./browser-api";
import { clearOncePerRun } from "./clear-once";
import { fetchResource } from "./fetch-resource";
import { ensureGraphReporter, graphReporter } from "./graph-reporter";
import { type IdleResult, recorderFor } from "./network-recorder";
import type { UiverifyPluginOptions } from "./options";
import { sharedIdWarning } from "./shared-ids";

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
 *    and `__uiverifyFetchResource`, which fetches a resource the page itself can't read,
 *  - registers the network-recording commands: on Playwright's Chromium the capture waits for the test's
 *    requests to finish and archives the bytes the page received (`network-recorder.ts`),
 *  - passes the global `disableAutoSnapshot` and `networkIdleTimeout` options to the browser via provide/inject,
 *  - clears the previous run's archive when the run starts.
 *
 * The archive lands in the same `./uiverify-archive` directory the `uiverify` CLI uploads.
 */
declare module "vitest" {
  interface ProvidedContext {
    __uiverify: { disableAutoSnapshot: boolean; networkIdleTimeout: number };
  }
}

/** The default `networkIdleTimeout`. */
const NETWORK_IDLE_TIMEOUT_MS = 5_000;

/** URLs (without their query) this process already warned were still loading at a capture, so a long poll
 *  warns once; a watch-mode rerun doesn't repeat the warning. */
const warnedPending = new Set<string>();

function warnStillLoading(id: string, timeout: number, urls: string[]): void {
  for (const url of urls) {
    let key = url;
    try {
      const parsed = new URL(url);
      key = parsed.origin + parsed.pathname;
    } catch {
      // Keep the raw URL as the key.
    }
    if (warnedPending.has(key)) continue;
    warnedPending.add(key);
    console.warn(
      `[uiverify] "${id}": captured while ${url} was still loading after ${timeout} ms. If it never finishes (a stream or long poll), mock it in the test, or set networkIdleTimeout: 0 to skip the wait.`,
    );
  }
}

const NOTHING_RECORDED: IdleResult = { pending: [], recorded: [] };

/** Move a Playwright page's pointer just outside the viewport, which hovers nothing. Between tests the
 *  pointer otherwise stays where the last one left it, and hovers whatever the next test renders there, so a
 *  capture would record a hover the test never made and that comes and goes with test order. */
async function parkPointer(ctx: unknown): Promise<void> {
  const page: unknown = typeof ctx === "object" && ctx !== null ? Reflect.get(ctx, "page") : undefined;
  const mouse: unknown = typeof page === "object" && page !== null ? Reflect.get(page, "mouse") : undefined;
  const move: unknown = typeof mouse === "object" && mouse !== null ? Reflect.get(mouse, "move") : undefined;
  if (typeof move === "function") await Reflect.apply(move, mouse, [-1, -1]);
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
      // Emit Vite's module graph as `preview-stats.json` so `uiverify upload` can skip unchanged
      // snapshots. `"default"` is kept so the plugin doesn't silence Vitest's own output. When
      // this project-level setting is ignored (the plugin inside `projects`), `configureVitest` below adds
      // the reporter to the root instead.
      reporters: ["default", graphReporter(outDir)],
      provide: {
        __uiverify: {
          disableAutoSnapshot: options.disableAutoSnapshot ?? false,
          networkIdleTimeout: options.networkIdleTimeout ?? NETWORK_IDLE_TIMEOUT_MS,
        },
      },
      browser: {
        commands: {
          __uiverifyWriteSnapshot: async (
            ctx: { project?: { name?: string; vitest?: object } },
            snapshot: CapturedSnapshot,
          ) => {
            const run = ctx.project?.vitest;
            const warning = run && sharedIdWarning(run, outDir, ctx.project?.name ?? "", snapshot.id);
            if (warning) console.warn(warning);
            writeSnapshot(outDir, snapshot);
          },
          __uiverifyFetchResource: async (_ctx: unknown, url: string) => fetchResource(url),
          // The network commands are best-effort: a failure answers "nothing recorded" and the capture takes
          // the path it takes without recording, never failing the test.
          __uiverifyWatchNetwork: async (ctx: unknown, href: string): Promise<number | null> => {
            try {
              return (await recorderFor(ctx)?.register(href)) ?? null;
            } catch {
              return null;
            }
          },
          __uiverifyWaitForNetworkIdle: async (
            ctx: unknown,
            token: number,
            timeout: number,
            id: string,
            test: string,
          ): Promise<IdleResult> => {
            try {
              const result = (await recorderFor(ctx)?.waitForIdle(token, timeout, test)) ?? NOTHING_RECORDED;
              warnStillLoading(id, timeout, result.pending);
              return result;
            } catch {
              return NOTHING_RECORDED;
            }
          },
          __uiverifyBeginNetworkTest: async (ctx: unknown, token: number): Promise<void> => {
            try {
              recorderFor(ctx)?.beginTest(token);
            } catch {
              // Best-effort, like the other network commands.
            }
          },
          // Best-effort too: another provider has no pointer to move, and the capture then records whatever
          // hover the run leaves behind.
          __uiverifyParkPointer: async (ctx: unknown): Promise<void> => {
            try {
              await parkPointer(ctx);
            } catch {
              // Best-effort, like the network commands.
            }
          },
          __uiverifyRecordedResources: async (ctx: unknown, token: number, urls: string[]) => {
            try {
              return (await recorderFor(ctx)?.recorded(token, urls)) ?? {};
            } catch {
              return {};
            }
          },
        },
      },
    },
  };

  return {
    name: "uiverify",
    config: () => config,
    resolveId: {
      // Ahead of Vite's own resolver, which would fail the import on Vitest 3 before this hook ran.
      order: "pre",
      handler(id, importer, opts) {
        return resolveBrowserApi(id, (target) => this.resolve(target, importer, opts));
      },
    },
    configureVitest: ({ vitest }) => {
      clearOncePerRun(vitest, outDir);
      ensureGraphReporter(vitest, outDir);
    },
  };
}
