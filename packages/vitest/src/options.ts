/** Options for {@link uiverifyPlugin}. */
export interface UiverifyPluginOptions {
  /** Directory archives are written to. Defaults to `UIVERIFY_ARCHIVE_DIR` or `./uiverify-archive` - the
   *  same directory the `uiverify` CLI uploads, so no extra wiring is needed. */
  outDir?: string;
  /** Turn off the automatic end-of-test snapshot for every test, so capture happens only where you call
   *  `takeSnapshot()`. Off by default (every browser-mode test archives its final DOM). */
  disableAutoSnapshot?: boolean;
}
