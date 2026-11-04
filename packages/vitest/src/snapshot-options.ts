/** A design image as `takeSnapshot` takes it: a URL or PNG data URI, or an image-import object with a
 *  `src` (what Next.js image handling resolves a PNG import to). */
export type DesignImage = string | { src: string };

/** What a `takeSnapshot()` call can set. Kept apart from the capture code so the public type declarations
 *  don't pull in its internal types (and the dev-only packages they come from). */
export interface SnapshotOptions {
  baselineImage?: DesignImage;
  /** `false` captures the page as it is right now, without waiting for animations and layout to finish
   *  (fonts and images still finish loading). On by default. */
  waitForStableFrame?: boolean;
}
