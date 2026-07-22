import path from "node:path";
import { test as base } from "@playwright/test";
import type { ArchivedSnapshotParams } from "./archive-types";
import { PlaywrightArchiver } from "./archiver";

/**
 * The `uiVerify` test fixture. Swap `import { test, expect } from "@playwright/test"` for this module
 * and every test archives its final UI state automatically — a one-line import swap, no per-test
 * boilerplate. Tests that want to capture intermediate states (or name them) can request the `uiVerify`
 * fixture and call `uiVerify.snapshot("after login")`.
 */
export interface UiVerifyFixture {
  /** Archive the page's current DOM as a snapshot. `name` distinguishes multiple snapshots in one test. */
  snapshot: (name?: string, params?: ArchivedSnapshotParams) => Promise<string>;
  /** Turn off the automatic end-of-test snapshot for this test (e.g. when you snapshot manually). */
  disableAutoSnapshot: () => void;
}

interface UiVerifyFixtures {
  uiVerify: UiVerifyFixture;
}

/** Where archives are written. Overridable so CI can point every worker at one bundle dir. */
function resolveOutDir(): string {
  return process.env.UIVERIFY_ARCHIVE_DIR ?? path.resolve(process.cwd(), "uiverify-archive");
}

export const test = base.extend<UiVerifyFixtures>({
  // `auto: true` so the fixture runs for EVERY test even when it isn't referenced — that's what makes the
  // import swap enough to get an end-of-test snapshot per test, with no per-test boilerplate.
  uiVerify: [
    async ({ page }, use, testInfo) => {
      const idBase = testInfo.titlePath.join(" > ");
      const title =
        testInfo.titlePath.length > 1 ? testInfo.titlePath.slice(0, -1).join(" > ") : (testInfo.titlePath[0] ?? "");
      const archiver = new PlaywrightArchiver(page, { outDir: resolveOutDir(), idBase, title });
      let auto = true;

      await use({
        snapshot: (name, params) => archiver.capture(name ?? "", params ?? {}),
        disableAutoSnapshot: () => {
          auto = false;
        },
      });

      // Auto-snapshot the final state — but only for a test that PASSED and didn't already snapshot, so
      // we never baseline a broken/aborted UI or double-capture a test that called snapshot() itself.
      if (auto && archiver.count === 0 && testInfo.status === testInfo.expectedStatus) {
        await archiver.capture();
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
