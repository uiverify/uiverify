import type { Page, Response } from "@playwright/test";
import {
  type ArchivedResource,
  type ArchivedSnapshot,
  type ArchivedSnapshotParams,
  writeSnapshot,
} from "@uiverify/archive-core";
import { rrwebRuntimeSource, RRWEB_GLOBAL } from "./rrweb-runtime";

/**
 * PlaywrightArchiver — the producer half of the E2E archive flow. It rides along a live Playwright
 * `page` during a test: it buffers the bytes of every resource the app loads, and on `capture()` it
 * serializes the current DOM (via rrweb, injected into the page) into a self-contained
 * {@link ArchivedSnapshot} written to disk. Those files are later assembled into a bundle by
 * `finalizeArchive` and replayed + diffed by UI Verify.
 *
 * Nothing here screenshots or diffs — capture is intentionally cheap and single-browser; the fidelity
 * work (determinism, cross-browser) happens on replay, off the archive.
 */

/** Resource types worth archiving for a static re-render: the visual assets. We deliberately skip
 *  `document`/`script`/`xhr`/`fetch` — the app's JS never re-runs on replay (rrweb neutralizes scripts)
 *  and API JSON isn't referenced by the serialized DOM, so archiving them would only bloat the bundle. */
const ARCHIVE_RESOURCE_TYPES = new Set(["image", "font", "stylesheet", "media", "other"]);

/** Per-resource size cap — a single asset larger than this is skipped (it would dominate the archive;
 *  a missed asset degrades to a blank on replay, which is a visible, debuggable gap rather than a hang). */
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

/** Bound how long `capture()` waits for still-in-flight resource bodies to buffer, so a slow/never-
 *  ending response (a hanging analytics beacon) can't wedge the test. */
const RESOURCE_DRAIN_TIMEOUT_MS = 5_000;

export interface ArchiverOptions {
  /** Directory the snapshot JSON files are written under (bundle root). `snapshots/` is created in it. */
  outDir: string;
  /** Stable base for the snapshot id — the baseline key. Typically the spec's title path joined, so the
   *  same assertion maps to the same baseline across runs. */
  idBase: string;
  /** Display grouping title (e.g. the spec/suite title). */
  title: string;
}

export class PlaywrightArchiver {
  private readonly resources = new Map<string, ArchivedResource>();
  private readonly bodyJobs = new Set<Promise<void>>();
  private captureCount = 0;

  constructor(
    private readonly page: Page,
    private readonly opts: ArchiverOptions,
  ) {
    this.page.on("response", (resp) => this.onResponse(resp));
  }

  /** How many snapshots this archiver has written — the fixture reads it to decide whether to take the
   *  automatic end-of-test snapshot (skipped if the test already took one explicitly). */
  get count(): number {
    return this.captureCount;
  }

  private onResponse(resp: Response): void {
    const type = resp.request().resourceType();
    if (!ARCHIVE_RESOURCE_TYPES.has(type)) return;
    const url = resp.url();
    if (url.startsWith("data:")) return; // already self-contained in the DOM
    const job = resp
      .body()
      .then((body) => {
        if (body.length > MAX_RESOURCE_BYTES) return;
        this.resources.set(url, {
          contentType: resp.headers()["content-type"] ?? null,
          status: resp.status(),
          body: body.toString("base64"),
        });
      })
      .catch(() => {
        // A body that can't be read (redirect, aborted, already-consumed) is simply not archived; the
        // replay serves a blank for it — a visible gap, never a crash.
      });
    this.bodyJobs.add(job);
    void job.finally(() => this.bodyJobs.delete(job));
  }

  /**
   * Serialize the page's CURRENT DOM into a snapshot file. Call it once the test has driven the UI to
   * the state you want checked (after your assertions). `name` distinguishes multiple snapshots within
   * one test; omit it for a test's single state.
   */
  async capture(name = "", params: ArchivedSnapshotParams = {}): Promise<string> {
    // Let outstanding resource bodies finish buffering (bounded), so late-loaded assets make the archive.
    await Promise.race([
      Promise.allSettled(this.bodyJobs),
      new Promise((r) => setTimeout(r, RESOURCE_DRAIN_TIMEOUT_MS)),
    ]);

    // Inject rrweb via evaluate (not addScriptTag) so a strict CSP on the app under test can't block it,
    // then serialize. `inlineStylesheet` folds external CSS into the DOM (so replay needs no CSS fetch);
    // `recordCanvas` captures canvas pixels; images stay as URLs, served from the resource archive.
    await this.page.evaluate(rrwebRuntimeSource());
    const serialize = (recordCanvas: boolean): Promise<string | null> =>
      this.page.evaluate(
        ({ rrwebGlobal, recordCanvas }) => {
          const r = (window as unknown as Record<string, { snapshot: (doc: Document, opts: unknown) => unknown }>)[
            rrwebGlobal
          ];
          // `slimDOM.script` drops <script> nodes: the archived DOM is replayed as static, settled pixels,
          // so the app's JS must NOT re-run on replay (it would mutate the DOM nondeterministically) — we
          // capture the result the test produced, not the app that produced it.
          const node = r.snapshot(document, { inlineStylesheet: true, recordCanvas, slimDOM: { script: true } });
          // Return a JSON STRING, not the object: a real page's serialized DOM is a deeply-nested tree, and
          // Playwright's structured return serialization rejects it ("object reference chain is too long")
          // above a depth/size limit. A string sidesteps that entirely (verified on large pages like Wikipedia).
          return node ? JSON.stringify(node) : null;
        },
        { rrwebGlobal: RRWEB_GLOBAL, recordCanvas },
      );
    // Try to capture canvas pixels, but a tainted/cross-origin canvas (a WebGL gradient, an ad) makes
    // rrweb's `toDataURL` throw SecurityError and abort the whole snapshot — so fall back to skipping
    // canvas capture (canvases replay blank) rather than failing to archive the page at all.
    let domJson: string | null;
    try {
      domJson = await serialize(true);
    } catch {
      domJson = await serialize(false);
    }
    if (!domJson) throw new Error(`@uiverify/playwright: rrweb failed to serialize the DOM for "${this.opts.idBase}"`);
    const dom: ArchivedSnapshot["dom"] = JSON.parse(domJson);

    const viewport = this.page.viewportSize() ?? { width: 1280, height: 800 };
    // Capture the device pixel ratio + color scheme off the live page so replay renders at the same
    // dimensions and theme the test saw (a dark-mode test replays dark, not a default). Read in one
    // round-trip; a failure falls back to the defaults (DSF 1 / light).
    const { deviceScaleFactor, colorScheme } = await this.page
      .evaluate(() => ({
        deviceScaleFactor: window.devicePixelRatio,
        colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? ("dark" as const) : ("light" as const),
      }))
      .catch(() => ({ deviceScaleFactor: undefined, colorScheme: undefined }));
    const id = name ? `${this.opts.idBase}::${name}` : this.opts.idBase;
    const snapshot: ArchivedSnapshot = {
      id,
      title: this.opts.title,
      name,
      viewport,
      ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
      ...(colorScheme ? { colorScheme } : {}),
      dom,
      resources: Object.fromEntries(this.resources),
      ...(params.delayMs ? { params } : {}),
    };

    writeSnapshot(this.opts.outDir, snapshot);
    this.captureCount++;
    return id;
  }
}
