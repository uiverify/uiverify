import { inject } from "vitest";
import { commands } from "vitest/browser";
import type { CapturedResource, CapturedSnapshot } from "@uiverify/archive-core";
import { createMirror } from "rrweb-snapshot";
import {
  collectResources,
  type FetchedResource,
  inlineBlobs,
  realNow,
  recordPseudoClasses,
  serializeDocument,
  settle,
  stillAnimatingWarning,
  waitForStableFrame,
} from "@uiverify/archive-core/browser";
import { snapshotIds, type TaskLike } from "./snapshot-id";
import { designDataUri } from "./design";
import type { SnapshotOptions } from "./snapshot-options";
import pkg from "../package.json";

/** Stamped into every snapshot so the CLI can report the capture SDK's version at upload. Inlined at
 *  build time (tsup bundles the JSON import), so it tracks the published version automatically. */
const PRODUCER = { name: pkg.name, version: pkg.version };

/**
 * The browser half of @uiverify/vitest. In Vitest browser mode the test body runs INSIDE the page, so
 * unlike the Playwright SDK there is no cross-process `page.evaluate`: we serialize the live document
 * with rrweb-snapshot in the same realm, collect the bytes of every loaded resource the snapshot references,
 * and hand the assembled {@link CapturedSnapshot} to the Node side over a Vitest browser command, which
 * writes it to disk. Nothing here touches the filesystem (there is none in the browser).
 */

/** The Node-side commands the plugin registers, added to the interface `vitest/browser` reads its
 *  `commands` from, so they are typed. */
declare module "vitest/internal/browser" {
  interface BrowserCommands {
    __uiverifyWriteSnapshot: (snapshot: CapturedSnapshot) => Promise<void>;
    __uiverifyFetchResource: (url: string) => Promise<FetchedResource>;
    __uiverifyWatchNetwork: (href: string) => Promise<number | null>;
    __uiverifyWaitForNetworkIdle: (
      token: number,
      timeout: number,
      id: string,
      test: string,
    ) => Promise<{ pending: string[]; recorded: string[] }>;
    __uiverifyBeginNetworkTest: (token: number) => Promise<void>;
    __uiverifyParkPointer: () => Promise<void>;
    __uiverifyRecordedResources: (token: number, urls: string[]) => Promise<Record<string, CapturedResource>>;
  }
}

/** This test file's document as the plugin's network recorder knows it, or `null` when the run isn't
 *  recorded (another provider or browser, or the recorder didn't find the page). */
let recording: number | null = null;

/** Ask the plugin to record this document's network. Called by the setup file once per test file, before the
 *  test file's own imports load anything. */
export async function watchNetwork(): Promise<void> {
  recording = await commands.__uiverifyWatchNetwork(location.href).catch(() => null);
}

/** Tell the recorder a test began, so its responses replace what earlier tests in the file recorded. */
export async function beginNetworkTest(): Promise<void> {
  if (recording !== null) await commands.__uiverifyBeginNetworkTest(recording).catch(() => undefined);
}

/** Move the pointer off the page between tests, so a capture records only the hover its own test made. */
export async function parkPointer(): Promise<void> {
  await commands.__uiverifyParkPointer().catch(() => undefined);
}

/** The plugin's `networkIdleTimeout`. */
function networkIdleTimeout(): number {
  try {
    return inject("__uiverify")?.networkIdleTimeout ?? 5_000;
  } catch {
    return 5_000;
  }
}

/** Wait for the document's requests to finish (up to `limit` ms as well as the option), and return the URLs
 *  the recorder holds bodies for. `test` names the test, which a long poll's exemption is scoped to. */
async function waitForNetwork(token: number, id: string, test: string, limit: number): Promise<string[]> {
  const timeout = Math.max(0, Math.min(networkIdleTimeout(), limit));
  const idle = await commands.__uiverifyWaitForNetworkIdle(token, timeout, id, test).catch(() => undefined);
  return idle?.recorded ?? [];
}

/** Serialize the page's current DOM into a {@link CapturedSnapshot}, ready for {@link writeCaptured}.
 *  `name` distinguishes multiple captures within one test; it is empty for a test's single auto-snapshot. */
export async function capture(
  task: TaskLike,
  { id, title }: { id: string; title: string },
  name: string,
  options: SnapshotOptions & { waitLimit?: number } = {},
): Promise<CapturedSnapshot> {
  // Checked by key, not value: `baselineImage: design.src` is undefined when the import is already a string,
  // and that must fail loudly rather than silently capture with no design.
  const design =
    "baselineImage" in options ? await designDataUri(id, options.baselineImage, location.href) : undefined;

  // Data a component fetches after render, and the images it then shows, must land first.
  const waitLimit = options.waitLimit ?? Number.POSITIVE_INFINITY;
  const waitStarted = realNow();
  const recorded =
    recording === null ? [] : await waitForNetwork(recording, id, snapshotIds(task, "").id, waitLimit);
  const token = recording;

  // Wait for the frame to settle before serializing: the archive is a static snapshot, so a JS animation
  // still running is baked in mid-tween, and a font or image still loading is absent from it (a fallback
  // glyph / a broken image). Opting out skips the animation and layout wait, never the font and image one:
  // a missing resource is never the frame anyone wanted. Every wait is time-boxed.
  if (options.waitForStableFrame === false) await settle();
  else if (await waitForStableFrame({ budgetMs: waitLimit - (realNow() - waitStarted) })) {
    console.warn(stillAnimatingWarning("@uiverify/vitest", id));
  }

  const mirror = createMirror();
  const dom = serializeDocument(mirror);
  if (!dom) throw new Error(`@uiverify/vitest: rrweb failed to serialize the DOM for "${id}"`);
  const pseudoClasses = recordPseudoClasses(mirror);

  await inlineBlobs(id, dom);
  const resources = await collectResources(id, dom, {
    loaded: recorded,
    ...(token === null ? {} : { fetchRecorded: (urls: string[]) => commands.__uiverifyRecordedResources(token, urls) }),
    fetchOutsidePage: (url) => commands.__uiverifyFetchResource(url),
  });
  const deviceScaleFactor = window.devicePixelRatio || undefined;
  const colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const);
  return {
    id,
    title,
    name,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    colorScheme,
    dom,
    resources,
    ...(pseudoClasses ? { pseudoClasses } : {}),
    producer: PRODUCER,
    // The test file (project-root-relative), so UI Verify can locate this snapshot in the module graph
    // for skip-unchanged. `task.file.name` is already root-relative — the same value snapshot ids derive
    // their first segment from — so it lines up with the graph names the reporter emits.
    ...(task.file?.name ? { sourcePath: task.file.name } : {}),
    ...(design ? { baselineImage: design } : {}),
  };
}

/** Hand a captured snapshot to the Node command that writes it into the archive. */
export function writeCaptured(snapshot: CapturedSnapshot): Promise<void> {
  return commands.__uiverifyWriteSnapshot(snapshot);
}
