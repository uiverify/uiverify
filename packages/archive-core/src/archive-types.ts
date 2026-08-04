/**
 * The E2E archive format the UI Verify capture SDKs write — the on-the-wire contract for what UI Verify
 * reads back. A capture SDK runs inside the user's test and PRODUCES an archive; UI Verify CONSUMES it.
 * The archive-format types live here as a standalone copy; the client never imports anything server-side.
 *
 * The idea (capture-and-replay): a Playwright/Vitest test drives the real app (or renders a component) to
 * a state, and instead of screenshotting live (single-browser, flaky), we capture a portable archive —
 * the serialized DOM (via rrweb-snapshot) plus every resource the browser loaded (bytes) — which UI
 * Verify re-renders and diffs later. That yields deterministic, cross-browser snapshots and an
 * inspectable archive; an archived state is addressed by a stable id, exactly like a Storybook story.
 *
 * The format is runner-agnostic: @uiverify/playwright and @uiverify/vitest both write it, and the reader
 * treats every archived state uniformly.
 */
import type { serializedNodeWithId } from "@rrweb/types";

/** One resource (image / font / stylesheet / …) the app loaded during the test, captured by URL so
 *  the replay can serve the exact bytes back instead of re-fetching from a network it can't reach. */
export interface ArchivedResource {
  /** Response `content-type`, replayed verbatim so the browser decodes the bytes the same way. */
  contentType: string | null;
  /** HTTP status the app saw (usually 200). Replayed so a captured 404/redirect stays faithful. */
  status: number;
  /** base64-encoded response body. base64 (not raw) so the archive is a plain JSON document. */
  body: string;
}

/** Author-controllable render knobs for one snapshot — the E2E analogue of a story's render params. */
export interface ArchivedSnapshotParams {
  /** Extra settle time (ms) before the screenshot. 0/undefined = none. */
  delayMs?: number;
}

/** The capture SDK that produced an archive - its npm package name and version. Stamped by the SDK so
 *  the CLI can report it at upload (`x-uiverify-sdk-*`) and UI Verify can nudge an outdated capture SDK.
 *  `@uiverify/playwright` and `@uiverify/vitest` are independent version lines, so the name is needed to
 *  pick the right floor. */
export interface ArchiveProducer {
  name: string;
  version: string;
}

/** One captured UI state: the serialized DOM + the resources it references + the capture geometry. */
export interface ArchivedSnapshot {
  /** Stable, human-readable id — the baseline key, analogous to a Storybook story id. Built from the
   *  test's file/title plus this snapshot's name, so the SAME assertion maps to the same baseline
   *  across runs (e.g. "login.spec.ts::logs in::after submit"). */
  id: string;
  /** Grouping title (the test/suite title), for dashboard display. */
  title: string;
  /** This capture's name within the test (e.g. "after submit"); "" for a test's single auto-snapshot. */
  name: string;
  /** Viewport at capture time — replayed so layout matches what the test saw. */
  viewport: { width: number; height: number };
  /** Device scale factor at capture time (defaults to 1). */
  deviceScaleFactor?: number;
  /** `prefers-color-scheme` at capture time — replayed so an app themed via the media query keeps the
   *  theme the test saw (an app themed via a class/attribute is already captured in the DOM). */
  colorScheme?: "light" | "dark";
  /** rrweb-snapshot serialized document node — rebuilt into a fresh document on replay. */
  dom: serializedNodeWithId;
  /** url → captured response, served back during replay instead of re-fetching from the network. */
  resources: Record<string, ArchivedResource>;
  params?: ArchivedSnapshotParams;
  /** The test file that produced this snapshot, relative to the Vite/project root (e.g.
   *  "components/Button.visual.test.tsx"). Written by @uiverify/vitest so UI Verify can locate this
   *  snapshot's "story module" in the emitted module graph for skip-unchanged. Absent for a Playwright
   *  archive (no module graph) and a pre-graph SDK. */
  sourcePath?: string;
  /** The SDK that wrote this snapshot. Stamped per-snapshot (not once) so the manifest pass can read it
   *  without a shared file that parallel test workers would race on. Absent on a pre-stamp archive. */
  producer?: ArchiveProducer;
}

/** One entry in an archive bundle's manifest. `type: "story"` so downstream code that already keys
 *  off Storybook-shaped entries treats an archived state uniformly. `snapshot` is the bundle-relative
 *  path to the {@link ArchivedSnapshot} JSON. */
export interface ArchiveIndexEntry {
  id: string;
  type: "story";
  title: string;
  name: string;
  snapshot: string;
  /** The producing test file, Vite/project-root-relative — lifted from the snapshot at manifest time.
   *  UI Verify projects it onto the story's `importPath` to locate it in the module graph for
   *  skip-unchanged. Absent for a Playwright archive (no graph) and a pre-graph SDK. */
  sourcePath?: string;
}

/** An archive bundle's manifest (`index.json`): every captured state in the build, by id. */
export interface ArchiveIndex {
  /** Format version, so the reader can reject an incompatible bundle instead of guessing. */
  v: 1;
  entries: Record<string, ArchiveIndexEntry>;
  /** The capture SDK that produced this bundle, lifted from the snapshots at manifest time. The CLI
   *  reads it to report `x-uiverify-sdk-*` at upload. Absent on a pre-stamp archive or a Storybook build. */
  producer?: ArchiveProducer;
}

/** The current archive format version — written by the producer, checked by the consumer. */
export const ARCHIVE_FORMAT_VERSION = 1 as const;
