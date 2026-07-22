/**
 * The E2E archive format this capture SDK writes — the on-the-wire contract for what UI Verify reads
 * back. This SDK runs inside the user's test and PRODUCES an archive; UI Verify CONSUMES it. The
 * archive-format types live here as a standalone copy; the client never imports anything server-side.
 *
 * The idea (capture-and-replay): a Playwright/Cypress test drives the real app to a state, and instead
 * of screenshotting live (single-browser, flaky), we capture a portable archive — the serialized DOM
 * (via rrweb-snapshot) plus every resource the browser loaded (bytes) — which UI Verify re-renders and
 * diffs later. That yields deterministic, cross-browser snapshots and an inspectable archive; an
 * archived state is addressed by a stable id, exactly like a Storybook story.
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
}

/** An archive bundle's manifest (`index.json`): every captured state in the build, by id. */
export interface ArchiveIndex {
  /** Format version, so the reader can reject an incompatible bundle instead of guessing. */
  v: 1;
  entries: Record<string, ArchiveIndexEntry>;
}

/** The current archive format version — written by the producer, checked by the consumer. */
export const ARCHIVE_FORMAT_VERSION = 1 as const;
