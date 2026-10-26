/**
 * `@uiverify/archive-core/browser` — the capture code that runs IN the page, shared by the SDKs that
 * capture there (@uiverify/vitest's browser setup, @uiverify/bun's page script): settling fonts and images,
 * seeding `Math.random`, serializing the DOM and archiving the resources it uses. Nothing here may import
 * Node: a Node import in a browser bundle is how @uiverify/vitest 1.0.1 broke (`import-graph.test.ts`).
 */
export { allElements, backgroundImageUrls, preloadFonts, settle, type SettleOptions } from "./settle";
export { installSeededRandom, resetSeed } from "./seed";
export { inlineBlobImages } from "./blob-urls";
export {
  archiveReferencedResources,
  archiveResources,
  beforeDeadline,
  FETCH_TIMEOUT_MS,
  type FetchedResource,
  type FetchOutsidePage,
  fontFaceKey,
  fontFaceRules,
  isArchivableResource,
  isModuleOrData,
  MAX_RESOURCE_BYTES,
  type MissingResource,
  nativeFetch,
  PAST_DEADLINE,
  referencedUrls,
  stylesheetUrls,
  toBase64,
} from "./resources";
export {
  collectResources,
  inlineBlobs,
  raiseResourceTimingBuffer,
  serializeDocument,
  type Warn,
} from "./capture-dom";
