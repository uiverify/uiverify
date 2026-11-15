import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, type Frame, type Page } from "@playwright/test";
import { resolveOutDir, UI_VERIFY_MARKER_SCRIPT, uiVerifyUserAgent } from "@uiverify/archive-core";
import { PlaywrightArchiver, type SnapshotOptions } from "./archiver";
import { pageScriptSource } from "./page-script";

/**
 * The `uiVerify` test fixture. Swap `import { test, expect } from "@playwright/test"` for this module
 * and every test that uses the built-in `page` archives its final UI state automatically — a one-line
 * import swap, no per-test boilerplate. A test that never loads anything into `page` (it drives a page it
 * opened itself) gets no automatic snapshot. Tests that want to capture intermediate states (or name them)
 * can request the `uiVerify` fixture and call `uiVerify.snapshot("after login")`.
 */
export interface UiVerifyFixture {
  /** Archive the page's DOM as a snapshot, once its frame is stable. `name` distinguishes multiple snapshots
   *  in one test; `{ waitForStableFrame: false }` captures the page as it is right now. */
  snapshot: (name?: string, options?: SnapshotOptions) => Promise<string>;
  /** Turn off the automatic end-of-test snapshot for this test (e.g. when you snapshot manually). */
  disableAutoSnapshot: () => void;
}

const BLANK_DOCUMENT = "<html><head></head><body></body></html>";

/** Whether `page` is the tab the test never used: nothing was loaded into it (`loaded`, set by the page's
 *  load / domcontentloaded / main-frame navigation events since setup) and its document is still the empty
 *  one every new tab opens with. Any error (a closed or crashed page) answers false, leaving that page to
 *  the capture as before. */
async function isUnusedBlankPage(page: Page, loaded: boolean): Promise<boolean> {
  if (loaded || page.isClosed() || page.url() !== "about:blank") return false;
  return page
    .evaluate(
      (blank) =>
        document.documentElement?.outerHTML === blank &&
        !document.body?.shadowRoot &&
        document.adoptedStyleSheets.length === 0,
      BLANK_DOCUMENT,
    )
    .catch(() => false);
}

let warnedBlankPage = false;

/** Playwright replaces a worker process after every unexpected failure, so a flag in this process alone would
 *  warn once per failing test. All workers of one run are forked by the same runner, so its pid names the
 *  run, and the first worker to create the marker file is the one that warns. The marker lives in the OS temp
 *  dir, not the archive dir, which is uploaded and not cleared between runs. */
function claimBlankPageWarning(): boolean {
  if (warnedBlankPage) return false;
  warnedBlankPage = true;
  try {
    fs.writeFileSync(path.join(os.tmpdir(), `uiverify-playwright-blank-page-${process.ppid}`), "", { flag: "wx" });
    return true;
  } catch (err) {
    return !(err instanceof Error && "code" in err && err.code === "EEXIST");
  }
}

function blankPageWarning(id: string): string {
  return `@uiverify/playwright: "${id}" never loaded anything into Playwright's built-in \`page\` (it is still a blank about:blank tab), so it has no automatic snapshot. If the test drives a page it opened itself (browser.newContext() / context.newPage()), drive the built-in \`page\` instead: UI Verify captures it, both automatically and with uiVerify.snapshot(), and for a test that logs in as one role, test.use({ storageState }) logs \`page\` in. If the test has no UI to capture (an API test), call uiVerify.disableAutoSnapshot() in it. Other tests in this run that end the same way are skipped without repeating this warning.`;
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
  // import swap enough to get an end-of-test snapshot of `page` per test, with no per-test boilerplate.
  uiVerify: [
    async ({ page }, use, testInfo) => {
      // Also flag every page via a `window` global at RECORD time, before the app's code runs, so
      // `isUIVerify()` is true even where the UA can't be read (the record-side analog of the second
      // signal the capturer sets at replay). Registered before the test navigates, so it applies to the
      // first goto.
      await page.addInitScript({ content: UI_VERIFY_MARKER_SCRIPT });
      // The page script tracks the app's animation frames from before its first script runs, so a capture
      // can wait for a JS animation to finish.
      await page.addInitScript({ content: pageScriptSource() });
      // The first `about:blank` document can still be settling when the fixture starts (Firefox fires its
      // load events late), so wait it out before listening: otherwise its own events mark every untouched
      // page as loaded. A page that already left `about:blank` is not waited on, since its load may never come.
      if (page.url() === "about:blank") await page.waitForLoadState();
      let loaded = false;
      const markLoaded = () => {
        loaded = true;
      };
      const markMainFrameLoaded = (frame: Frame) => {
        if (frame === page.mainFrame()) markLoaded();
      };
      page.on("load", markLoaded);
      page.on("domcontentloaded", markLoaded);
      page.on("framenavigated", markMainFrameLoaded);
      const idBase = testInfo.titlePath.join(" > ");
      const title =
        testInfo.titlePath.length > 1 ? testInfo.titlePath.slice(0, -1).join(" > ") : (testInfo.titlePath[0] ?? "");
      const configDir = testInfo.config.configFile ? path.dirname(testInfo.config.configFile) : testInfo.config.rootDir;
      const sourcePath = path.relative(configDir, testInfo.file).split(path.sep).join("/");
      // Fixture setup runs inside the test's timeout, so time counted from here only errs long by the moment
      // before it.
      const startedAt = Date.now();
      const timeLeft = () =>
        testInfo.timeout > 0 ? testInfo.timeout - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;
      const archiver = new PlaywrightArchiver(page, { outDir: resolveOutDir(), idBase, title, sourcePath, timeLeft });
      let auto = true;

      await use({
        snapshot: (name, options) => archiver.capture(name ?? "", options ?? {}),
        disableAutoSnapshot: () => {
          auto = false;
        },
      });
      // A `page` fixture override can hand every test the same long-lived page (an Electron window).
      page.off("load", markLoaded);
      page.off("domcontentloaded", markLoaded);
      page.off("framenavigated", markMainFrameLoaded);

      // Auto-snapshot the final state unless the test already snapshotted itself. A failed test is captured
      // too: its own report says it failed, while a snapshot that vanished from the build would hide that its
      // UI changed. A test that timed out or was interrupted is not: its page may be stuck, and a capture
      // that never returns would hold up the teardown. When a failed test leaves no page to capture (a
      // crash, a closed page), that capture error is left out of its report.
      if (auto && archiver.count === 0 && (testInfo.status === "passed" || testInfo.status === "failed")) {
        if (await isUnusedBlankPage(page, loaded)) {
          // Create the archive dir so a run where every test is skipped reaches the CLI's "nothing to upload"
          // message rather than "--static-dir does not exist".
          fs.mkdirSync(resolveOutDir(), { recursive: true });
          if (claimBlankPageWarning()) console.warn(blankPageWarning(idBase));
          return;
        }
        try {
          await archiver.capture();
        } catch (err) {
          if (testInfo.status === "passed") throw err;
        }
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
