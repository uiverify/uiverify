/**
 * `@uiverify/archive-core/browser` — the capture code that runs IN the page, shared by the SDKs that
 * capture there (@uiverify/vitest's browser setup, the @uiverify/bun and @uiverify/playwright page scripts):
 * settling fonts, images and animation, seeding `Math.random`, serializing the DOM and archiving the
 * resources it uses. Nothing here may import Node: a Node import in a browser bundle is how
 * @uiverify/vitest 1.0.1 broke (`import-graph.test.ts`).
 */
export { allElements, backgroundImageUrls, preloadFonts, settle, type SettleOptions } from "./settle";
export { stillAnimatingWarning } from "./messages";
export { installRafProbe, type StableFrameOptions, waitForStableFrame } from "./stable-frame";
export { realNow } from "./real-timers";
export { installSeededRandom, resetSeed } from "./seed";
export { inlineBlobImages } from "./blob-urls";
export {
  archiveReferencedResources,
  archiveResources,
  beforeDeadline,
  FETCH_TIMEOUT_MS,
  type FetchedResource,
  type FetchOutsidePage,
  type FetchRecorded,
  fontFaceKey,
  fontFaceRules,
  isArchivableResource,
  isModuleOrData,
  MAX_RESOURCE_BYTES,
  type MissingResource,
  nativeFetch,
  PAST_DEADLINE,
  referencedUrls,
  type ResourceSources,
  stylesheetUrls,
  toBase64,
} from "./resources";
export {
  collectResources,
  inlineBlobs,
  raiseResourceTimingBuffer,
  recordPseudoClasses,
  serializeDocument,
  type Warn,
} from "./capture-dom";
