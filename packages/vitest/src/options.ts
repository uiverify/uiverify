/** Options for {@link uiverifyPlugin}. */
export interface UiverifyPluginOptions {
  /** Directory archives are written to. Defaults to `UIVERIFY_ARCHIVE_DIR` or `./uiverify-archive` - the
   *  same directory the `uiverify` CLI uploads, so no extra wiring is needed. */
  outDir?: string;
  /** Turn off the automatic end-of-test snapshot for every test, so capture happens only where you call
   *  `takeSnapshot()`. Off by default (every browser-mode test archives its final DOM). */
  disableAutoSnapshot?: boolean;
  /** How long a capture waits for the test's network requests to finish before it snapshots, in ms (with the
   *  Playwright provider on Chromium, the supported setup; other providers don't wait). The
   *  snapshot is taken once nothing has been loading for 100 ms, or when this time runs out, which never fails
   *  the test. `0` skips the wait. Default 5000. */
  networkIdleTimeout?: number;
}
