/**
 * The page script: one browser bundle the archiver installs in every document before the app's own scripts
 * (`addInitScript`), and evaluates into a page that missed it (one built with `setContent`, say). It tracks
 * the app's animation frames from the start and exposes the settle the archiver runs before serializing.
 */
import { installRafProbe, settle, type SettleOptions, waitForStableFrame } from "@uiverify/archive-core/browser";
import { PAGE_HELPERS_GLOBAL } from "./protocol";

if (!Reflect.has(globalThis, PAGE_HELPERS_GLOBAL)) {
  installRafProbe();
  let switched: HTMLImageElement[] = [];
  Reflect.set(globalThis, PAGE_HELPERS_GLOBAL, {
    /** Resolves `true` when an animation was still running at the deadline. */
    settle: async (stableFrame: boolean, budgetMs: number | null): Promise<boolean> => {
      // Wrap the page's requestAnimationFrame again if Playwright's clock replaced it since.
      installRafProbe();
      switched = [];
      // A real page: wait only for the fonts it already uses, and load its below-the-fold `loading="lazy"`
      // images, which a test that never scrolls to them leaves unfetched and so out of the archive.
      const options: SettleOptions = { fonts: "used", lazyToEager: true, switched };
      if (stableFrame) return waitForStableFrame({ ...options, ...(budgetMs === null ? {} : { budgetMs }) });
      await settle(options);
      return false;
    },
    /** Once the DOM is serialized, put back the `loading="lazy"` the settle switched, so the rest of the test
     *  runs against the page it built (the images it loaded stay loaded). */
    restore: () => {
      for (const img of switched) img.loading = "lazy";
      switched = [];
    },
  });
}
