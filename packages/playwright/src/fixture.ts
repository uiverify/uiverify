import { test as base } from "@playwright/test";
import {
  type ArchivedSnapshotParams,
  resolveOutDir,
  UI_VERIFY_MARKER_SCRIPT,
  uiVerifyUserAgent,
} from "@uiverify/archive-core";
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

interface UiVerifyWorkerFixtures {
  /** The launched browser's own user-agent, read once per worker. The base we append the UI Verify
   *  marker to when the test hasn't set its own `userAgent`, so we never discard the real Chromium UA. */
  uiVerifyBaseUserAgent: string;
}

export const test = base.extend<UiVerifyFixtures, UiVerifyWorkerFixtures>({
  uiVerifyBaseUserAgent: [
    async ({ browser }, use) => {
      // Read the browser's default UA from a throwaway context (there is no API for it without a page),
      // once per worker. Cheap relative to a worker's lifetime, and it keeps the marker an *append* to the
      // real UA rather than a hardcoded replacement that could fool UA sniffing in the app under test.
      const probe = await browser.newContext();
      try {
        const page = await probe.newPage();
        await use(await page.evaluate(() => navigator.userAgent));
      } finally {
        await probe.close();
      }
    },
    { scope: "worker" },
  ],

  // Append the UA marker via the top-level `userAgent` option so `navigator.userAgent` carries it while
  // we record — the record-side analog of the capturer appending it at replay, which makes the
  // `navigator.userAgent` branch of `isUIVerify()` (`/docs/is-ui-verify`) true for the SDK rather than a
  // dead branch. `userAgent` is `undefined` by default, so we fall back to the browser's real UA (read
  // once per worker) and never hand the app a fake browser string.
  //
  // Limitation, by Playwright design: when a test/config sets its OWN `userAgent` (e.g. `devices[...]`),
  // Playwright's `use` replaces this option resolver with that literal value, so our marker is not
  // appended in that case. `isUIVerify()` still returns true there via the `window.__UI_VERIFY__` global
  // we set unconditionally below — the two signals are `or`-ed, and the global needs no UA cooperation.
  userAgent: async ({ userAgent, uiVerifyBaseUserAgent }, use) => {
    await use(uiVerifyUserAgent(userAgent ?? uiVerifyBaseUserAgent));
  },

  // `auto: true` so the fixture runs for EVERY test even when it isn't referenced — that's what makes the
  // import swap enough to get an end-of-test snapshot per test, with no per-test boilerplate.
  uiVerify: [
    async ({ page }, use, testInfo) => {
      // Also flag every page via a `window` global at RECORD time, before the app's code runs, so
      // `isUIVerify()` is true even where the UA can't be read (the record-side analog of the second
      // signal the capturer sets at replay). Registered before the test navigates, so it applies to the
      // first goto.
      await page.addInitScript({ content: UI_VERIFY_MARKER_SCRIPT });
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
