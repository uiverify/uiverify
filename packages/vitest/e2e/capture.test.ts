import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Builds the package, runs the fixture suite in `e2e/fixture` against the build in real headless Chromium,
 * then checks the archive it wrote. This is the only test of the browser half (the setup hooks, the capture,
 * the browser commands), and running the build also catches a bundle that breaks only in the browser.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = path.join(packageDir, "node_modules/.bin/vitest");

interface ReadSnapshot {
  dom: string;
  resources: Record<string, { file?: string }>;
  pseudoClasses?: Record<string, number[]>;
  /** The serialized node of each rrweb id, so a test can say which element an id names. */
  nodes: Map<number, SerializedNode>;
}

interface SerializedNode {
  id: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SerializedNode[];
}

interface RunResult {
  snapshots: Map<string, ReadSnapshot>;
  failed: Map<string, string>;
  durations: Map<string, number>;
  output: string;
  files: string[];
  outDir: string;
}

/** A real font file to serve, so the page loads it: the icon font Playwright ships. */
function findFont(): Buffer {
  const resolveFrom = (from: string, id: string) => createRequire(from).resolve(id);
  const playwright = resolveFrom(resolveFrom(path.join(packageDir, "package.json"), "@vitest/browser-playwright"), "playwright/package.json");
  const core = path.dirname(resolveFrom(playwright, "playwright-core/package.json"));
  const font = fs.readdirSync(core, { recursive: true, encoding: "utf8" }).find((file) => file.endsWith(".ttf"));
  if (!font) throw new Error("no .ttf in playwright-core");
  return fs.readFileSync(path.join(core, font));
}

let fontBytes: Buffer;
/** A real 1×1 PNG: Chromium keeps no body for an image it can't decode, so a fake one would never be
 *  recorded. Bytes after its end mark each response apart, and the image still decodes. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const png = (mark: string) => Buffer.concat([PNG, Buffer.from(mark)]);
let changingHits = 0;
let onceHits = 0;
let changingSheetHits = 0;
const neverAnswered: http.ServerResponse[] = [];
let assets: http.Server;
let origin: string;
const dirs: string[] = [];
/** The fixture runs in a repository of its own, whose index tracks exactly the fixture's files, so the
 *  SDK build it loads sits outside the repository like a dependency in node_modules, and the graph's
 *  source check sees the fixture whether or not its files are committed here yet. */
let fixtureGit: Record<string, string>;

/** Assets on another origin than the test page, served with no CORS headers (but the font). */
beforeAll(async () => {
  await promisify(execFile)(path.join(packageDir, "node_modules/.bin/tsup"), [], { cwd: packageDir });
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-e2e-git-"));
  dirs.push(gitDir);
  fixtureGit = { GIT_DIR: gitDir, GIT_WORK_TREE: fixture };
  const env = { ...process.env, ...fixtureGit };
  await promisify(execFile)("git", ["init", "-q"], { cwd: fixture, env });
  await promisify(execFile)("git", ["add", "-A", "--", ".", ":!node_modules"], { cwd: fixture, env });
  fontBytes = findFont();
  assets = http.createServer((req, res) => {
    if (req.url === "/icon.png" || req.url === "/frozen.png") {
      return void res.writeHead(200, { "content-type": "image/png" }).end("png-bytes");
    }
    if (req.url === "/changing.png" || req.url?.startsWith("/changing.png?")) {
      changingHits++;
      return void res
        .writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
        .end(png(`changing-${changingHits}`));
    }
    if (req.url === "/changing.css") {
      changingSheetHits++;
      return void res
        .writeHead(200, { "content-type": "text/css", "cache-control": "no-store" })
        .end(`/* sheet-${changingSheetHits} */`);
    }
    if (req.url === "/redirect.png") {
      return void res.writeHead(302, { location: "/changing.png?from=redirect", "cache-control": "no-store" }).end();
    }
    if (req.url === "/once.png") {
      onceHits++;
      if (onceHits > 1) return void res.writeHead(404, { "content-type": "text/plain" }).end("gone");
      return void res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(png("once-bytes"));
    }
    if (req.url === "/slow-data" || req.url === "/slower-data") {
      return void setTimeout(() => {
        res
          .writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
          .end(JSON.stringify({ src: `${origin}/late.png` }));
      }, req.url === "/slow-data" ? 300 : 1500);
    }
    if (req.url === "/late.png") return void res.writeHead(200, { "content-type": "image/png" }).end(png("late-bytes"));
    // Never answered: a stream, a long poll or a hung server, as far as the page can tell.
    if (req.url === "/never" || req.url === "/never-short") return void neverAnswered.push(res);
    // Bytes Chromium can't decode as an image, so it keeps no body and the recorder never sees these: only
    // Resource Timing finds them, which is what the >250 resources test guards.
    if (req.url?.startsWith("/many/")) {
      return void res
        .writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" })
        .end("png-bytes");
    }
    if (req.url === "/font.css") {
      return void res
        .writeHead(200, { "content-type": "text/css" })
        .end(
          "@font-face{font-family:Brand;src:url(brand.ttf)}" +
            "@font-face{font-family:Brand;src:url(brand-cyrillic.ttf);unicode-range:U+0400-04FF}",
        );
    }
    // Fonts load in CORS mode, so like a font CDN this one allows any origin; the sheet naming it doesn't.
    if (req.url === "/brand.ttf") {
      return void res
        .writeHead(200, { "content-type": "font/ttf", "access-control-allow-origin": "*" })
        .end(fontBytes);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((resolve) => assets.listen(0, "127.0.0.1", resolve));
  const address = assets.address();
  if (!address || typeof address === "string") throw new Error("asset server has no port");
  origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  for (const res of neverAnswered.splice(0)) res.destroy();
  // Unset when the build in `beforeAll` failed.
  if (assets) {
    assets.closeAllConnections();
    await new Promise<void>((resolve) => assets.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-e2e-"));
  dirs.push(dir);
  return dir;
}

async function runFixture(args: string[] = [], env: Record<string, string> = {}, outDir = tempDir()): Promise<RunResult> {
  const report = path.join(outDir, "report.json");
  let output = "";
  try {
    const run = await promisify(execFile)(
      vitestBin,
      ["run", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`, ...args],
      { cwd: fixture, env: { ...process.env, ...fixtureGit, UIVERIFY_ARCHIVE_DIR: outDir, UIVERIFY_E2E_ASSETS: origin, ...env } },
    );
    output = run.stdout + run.stderr;
  } catch (err) {
    // The fixture has tests that fail on purpose, so the run exits non-zero.
    if (typeof err !== "object" || err === null || !("stdout" in err)) throw err;
    output = String(err.stdout) + String(Reflect.get(err, "stderr"));
  }
  const snapshots = new Map<string, ReadSnapshot>();
  const snapshotDir = path.join(outDir, "snapshots");
  for (const file of fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : []) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, file), "utf8"));
    const nodes: ReadSnapshot["nodes"] = new Map();
    const visit = (node: SerializedNode) => {
      nodes.set(node.id, node);
      for (const child of node.childNodes ?? []) visit(child);
    };
    visit(snapshot.dom);
    snapshots.set(snapshot.id, {
      dom: JSON.stringify(snapshot.dom),
      resources: snapshot.resources,
      pseudoClasses: snapshot.pseudoClasses,
      nodes,
    });
  }
  const failed = new Map<string, string>();
  const durations = new Map<string, number>();
  const results = JSON.parse(fs.readFileSync(report, "utf8"));
  for (const file of results.testResults) {
    for (const test of file.assertionResults) {
      if (test.status === "failed") failed.set(test.fullName, test.failureMessages.join("\n"));
      durations.set(test.fullName, test.duration);
    }
  }
  return { snapshots, failed, durations, output, files: fs.readdirSync(outDir), outDir };
}

describe("a browser-mode run", () => {
  let run: RunResult;
  beforeAll(async () => {
    run = await runFixture();
  }, 180_000);

  /** Catches the plugin inside a `projects` entry writing no module graph, so skipping unchanged tests
   *  saves nothing. */
  it("writes the module graph", () => {
    expect(run.files).toContain("preview-stats.json");
  });

  /** Catches the source check dropping a test that imports tracked source, keeping one that imports none,
   *  or shipping a graph without the marker the CLI requires. */
  it("keeps the tests that import tracked source in the graph, and says which always render", () => {
    const stats = JSON.parse(fs.readFileSync(path.join(run.outDir, "preview-stats.json"), "utf8"));
    expect(stats.uiverify).toEqual({ sourceChecked: true });
    const modules = new Map<string, string[]>(
      stats.modules.map((m: { name: string; reasons: { moduleName: string }[] }) => [m.name, m.reasons.map((r) => r.moduleName)]),
    );
    expect(modules.get("visual/loaded.ts")).toEqual(["visual/resources.capture.ts"]);
    expect(modules.has("visual/errors.capture.ts")).toBe(false);
    expect(run.output).toContain("[uiverify] The tests in 6 file(s) always render: they import no tracked source file");
  });

  /** Catches the automatic snapshot running after a test file's cleanup `afterEach`, archiving an empty
   *  page. */
  it("captures the page before the test file's cleanup runs", () => {
    expect(run.snapshots.get("visual/hooks.capture.ts > cleaned up after")?.dom).toContain("rendered");
  });

  /** Catches an `afterEach` that takes its own snapshot gaining an extra automatic one, one that opts the
   *  test out being ignored, and a failed test's capture vanishing from the build. */
  it("lets afterEach hooks take their own snapshot or opt out, and captures a failed test", () => {
    const ids = [...run.snapshots.keys()].filter((id) => id.startsWith("visual/hooks.capture.ts > "));
    expect(ids.sort()).toEqual([
      "visual/hooks.capture.ts > cleaned up after",
      "visual/hooks.capture.ts > failing afterEach > fails after the body",
      "visual/hooks.capture.ts > fake timers > image under a frozen clock",
      "visual/hooks.capture.ts > snapshot in afterEach > settles in a hook",
    ]);
    expect(run.failed.has("failing afterEach fails after the body")).toBe(true);
  });

  /** Catches the capture reading Resource Timing through the fake `performance` `vi.useFakeTimers()`
   *  installs, which lists nothing, so no image or font was archived. */
  it("archives resources while fake timers are installed", () => {
    const id = "visual/hooks.capture.ts > fake timers > image under a frozen clock";
    expect(Object.keys(run.snapshots.get(id)?.resources ?? {})).toEqual([`${origin}/frozen.png`]);
  });

  /** Catches a capture that doesn't wait for a requestAnimationFrame animation, archiving a frame mid-tween. */
  it("archives a finite animation's last frame", () => {
    expect(run.snapshots.get("visual/stable-frame.capture.ts > finite animation")?.dom).toContain("done");
  });

  /** Catches a capture under fake timers replacing requestAnimationFrame: `vi.useRealTimers()` then deletes
   *  the global it finds replaced, and every later test that animates throws. */
  it("leaves requestAnimationFrame in place after a snapshot under fake timers", () => {
    expect(run.snapshots.has("visual/stable-frame.capture.ts > fake timers > snapshot under fake timers")).toBe(true);
    expect(run.failed.has("requestAnimationFrame survives fake timers")).toBe(false);
    expect(run.snapshots.get("visual/stable-frame.capture.ts > finite animation")?.dom).toContain("done");
  });

  /** Catches the opt-out still waiting, so a test can't capture the page as it is right now. */
  it("captures mid-animation with waitForStableFrame off", () => {
    const dom = run.snapshots.get("visual/stable-frame.capture.ts > finite animation, captured right now")?.dom;
    expect(dom).toContain("frame");
    expect(dom).not.toContain("done");
  });

  /** Catches the opt-out skipping the font and image settle too: a missing image is never the frame anyone
   *  wanted. The settle is what switches a lazy image to eager. */
  it("still settles images with waitForStableFrame off", () => {
    expect(run.snapshots.get("visual/stable-frame.capture.ts > lazy image, captured right now")?.dom).toContain(
      '"loading":"eager"',
    );
  });

  /** Catches the wait hanging on an animation that never ends: the capture must give up and say why. */
  it("captures an endless animation at the deadline, and warns", () => {
    expect(run.snapshots.get("visual/stable-frame.capture.ts > endless animation")?.dom).toContain("frame");
    expect(run.failed.has("endless animation")).toBe(false);
    expect(run.output).toContain('"visual/stable-frame.capture.ts > endless animation" was still animating');
  });

  /** Catches the wait ignoring the test's timeout: four snapshots of an endless animation at the full 4 s each
   *  would time out a 10 s test that passes without the wait. */
  it("keeps several snapshots of an endless animation within the test's timeout", () => {
    expect(run.failed.has("endless animation, several snapshots")).toBe(false);
    expect(run.snapshots.has("visual/stable-frame.capture.ts > endless animation, several snapshots::four")).toBe(true);
  });

  /** Catches the second of two same-titled tests taking the first one's id when the first fails. */
  it("gives every snapshot its own id", () => {
    expect(run.snapshots.get("visual/ids.capture.ts > two snapshots")?.dom).toContain("one");
    expect(run.snapshots.get("visual/ids.capture.ts > two snapshots #2")?.dom).toContain("two");
    expect(run.snapshots.has("visual/ids.capture.ts > same title")).toBe(true);
    expect(run.snapshots.get("visual/ids.capture.ts > same title (2)")?.dom).toContain("second");
  });

  it("fails a test that doesn't await takeSnapshot(), in the test or in an afterEach", () => {
    expect(run.failed.get("not awaited")).toContain("takeSnapshot() call was not awaited");
    expect(run.failed.get("not awaited in afterEach left running")).toContain("takeSnapshot() call was not awaited");
  });

  /** Catches a passing test whose automatic capture failed going green with no snapshot, and a failed
   *  test's report gaining the capture error on top of its own failure. */
  it("fails a passing test whose capture failed, and leaves a failed test's report alone", () => {
    expect(run.failed.get("capture fails on a passing test")).toContain("capture broke");
    const failing = run.failed.get("capture fails on a failing test");
    expect(failing).toContain("the test's own failure");
    expect(failing).not.toContain("capture broke");
  });

  /** Catches a cross-origin image with no CORS headers replaying blank: the page can't read it. */
  it("archives a cross-origin image the page can't read", () => {
    expect(Object.keys(run.snapshots.get("visual/resources.capture.ts > cross-origin image without CORS")?.resources ?? {}))
      .toEqual([`${origin}/icon.png`]);
  });

  /** Catches a web font from a `<link>` without `crossorigin` replaying in a fallback font: Chromium hides
   *  what that sheet loads from Resource Timing. The sheet's cyrillic face fails to load (its file is
   *  missing), so it is neither archived nor warned about. */
  it("archives the fonts the page loaded from a cross-origin stylesheet, and not a face that failed", () => {
    const id = "visual/resources.capture.ts > web font from a cross-origin link without crossorigin";
    expect(Object.keys(run.snapshots.get(id)?.resources ?? {}).sort()).toEqual(
      [`${origin}/brand.ttf`, `${origin}/font.css`].sort(),
    );
    expect(run.output).not.toContain("brand-cyrillic");
  });

  it("warns about a resource it could not archive", () => {
    expect(run.output).toContain(`could not archive ${origin}/gone.png (HTTP 404)`);
  });

  it("warns about a blob: image it can no longer read", () => {
    expect(run.output).toMatch(/blob image revoked once it loaded": could not archive blob:/);
  });

  /** Catches an image requested after the page's first 250 resources going unarchived: Chromium stops
   *  adding Resource Timing entries once its default buffer is full. */
  it("archives the last of more resources than the Resource Timing buffer holds by default", () => {
    const id = "visual/resources.capture.ts > more images than the Resource Timing buffer's default 250 entries";
    const urls = Object.keys(run.snapshots.get(id)?.resources ?? {}).filter((url) => url.includes("/many/"));
    expect(urls).toHaveLength(300);
    expect(urls).toContain(`${origin}/many/299.png`);
  });

  /** The archived bytes of `url` in snapshot `id`, as the archive stores them. */
  function archived(id: string, url: string): string | undefined {
    const file = run.snapshots.get(`visual/network.capture.ts > ${id}`)?.resources[url]?.file;
    return file === undefined ? undefined : fs.readFileSync(path.join(run.outDir, file)).subarray(PNG.length).toString();
  }

  /** Catches the archive downloading an image again instead of keeping what the page drew: a URL that
   *  answers differently each time replays a different image. */
  it("archives the bytes the page received, not a second download", () => {
    expect(archived("image whose bytes change on every request", `${origin}/changing.png`)).toBe("changing-1");
  });

  /** Catches a later test losing an image an earlier test in the file loaded: Chromium shows it from its
   *  cache without a new request, so nothing new reaches the network. */
  it("archives what a later test showed from the cache, without downloading it again", () => {
    expect(archived("the changing image again, in a later test", `${origin}/changing.png`)).toBe("changing-1");
  });

  /** Catches a later test archiving an earlier test's bytes for a URL the page requested again: a
   *  cross-origin stylesheet, which the archive keeps as a file, is fetched anew each time it's added. */
  it("archives a later test's own response for a URL an earlier test recorded", () => {
    const sheet = (id: string) => {
      const file = run.snapshots.get(`visual/network.capture.ts > ${id}`)?.resources[`${origin}/changing.css`]?.file;
      return file === undefined ? undefined : fs.readFileSync(path.join(run.outDir, file), "utf8");
    };
    const first = sheet("stylesheet whose content changes on every request");
    const second = sheet("the changing stylesheet again, in a later test");
    expect(first).toMatch(/^\/\* sheet-\d+ \*\/$/);
    expect(second).toMatch(/^\/\* sheet-\d+ \*\/$/);
    expect(second).not.toBe(first);
  });

  /** Catches a `takeSnapshot()` waiting longer than its test has left: the test's 5 s timeout can't fit the
   *  5 s wait and the capture. */
  it("keeps a takeSnapshot() wait inside a short test timeout", () => {
    expect(run.failed.has("a short test that snapshots while a request never finishes")).toBe(false);
    expect(run.snapshots.has("visual/network.capture.ts > a short test that snapshots while a request never finishes::short")).toBe(true);
  });

  /** Catches a manual `takeSnapshot()` firing while the data the component fetched is in flight. */
  it("waits for the network before a takeSnapshot() too", () => {
    const id = "visual/network.capture.ts > takeSnapshot() right after a fetch starts::after fetch";
    expect(run.snapshots.get(id)?.dom).toContain("manual");
  });

  /** The tag and `id` attribute of the elements a snapshot recorded in `cls`. */
  function inPseudoClass(test: string, cls: string): string[] {
    const snapshot = run.snapshots.get(`visual/pseudo.capture.ts > ${test}`);
    return (snapshot?.pseudoClasses?.[cls] ?? []).map((id) => {
      const node = snapshot?.nodes.get(id);
      const elId = node?.attributes?.id;
      return typeof elId === "string" ? `${node?.tagName}#${elId}` : String(node?.tagName);
    });
  }

  /** Catches a hovered element replaying idle: rrweb serializes the DOM, not `:hover`, so the capture has
   *  to record the hovered chain itself for UI Verify to force it back. */
  it("records the hovered element and its ancestors", () => {
    expect(inPseudoClass("hovered button", "hover")).toEqual(["html", "body", "button#target"]);
    expect(inPseudoClass("hovered button", "focus")).toEqual([]);
  });

  /** Catches a focused input replaying without its focus ring, or its form losing `:focus-within`. */
  it("records the focused input, its focus ring, and the ancestors it focuses within", () => {
    expect(inPseudoClass("focused input", "focus")).toEqual(["input#field"]);
    expect(inPseudoClass("focused input", "focus-visible")).toEqual(["input#field"]);
    expect(inPseudoClass("focused input", "focus-within")).toEqual(["html", "body", "form", "input#field"]);
  });

  /** Catches a capture that only queries the light DOM, which can't see into an open shadow root. */
  it("records a hovered element inside an open shadow root", () => {
    expect(inPseudoClass("hovered inside a shadow root", "hover")).toEqual(["html", "body", "div#host", "span#inner"]);
  });

  /** Under the default hook order: catches a park that runs after the test's own `beforeEach`, undoing the
   *  hover it made. */
  it("keeps a hover made in a beforeEach", () => {
    expect(inPseudoClass("hovered in a beforeEach > keeps the hover", "hover")).toEqual(["html", "body", "button#target"]);
  });

  /** Catches a capture recording a hover the test never made: the pointer stays where the previous test
   *  left it, so whatever renders under it would replay hovered, and change with test order. */
  it("records no hover a test didn't make", () => {
    const snapshot = run.snapshots.get("visual/pseudo.capture.ts > button where an earlier test left the pointer");
    expect(snapshot).toBeDefined();
    expect(snapshot?.pseudoClasses).toBeUndefined();
    expect(inPseudoClass("focused input", "hover")).toEqual([]);
  });

  /** Catches a sequential test inheriting the pointer a concurrent test left, which no park after it moved. */
  it("records no hover left by a concurrent test", () => {
    const snapshot = run.snapshots.get("visual/pseudo.capture.ts > button after a concurrent test");
    expect(snapshot).toBeDefined();
    expect(snapshot?.pseudoClasses).toBeUndefined();
  });

  /** Catches the park being skipped when the previous test's capture throws. */
  it("records no hover left by a test whose capture failed", () => {
    expect(run.failed.get("hovered, then its capture fails")).toContain("capture broke");
    const snapshot = run.snapshots.get("visual/pseudo.capture.ts > button after a failed capture");
    expect(snapshot).toBeDefined();
    expect(snapshot?.pseudoClasses).toBeUndefined();
  });

  /** Catches a redirected image (a random-avatar service) being downloaded again under the URL the DOM
   *  names, which lands on a different image. */
  it("archives a redirected image under the URL the page asked for", () => {
    // The page's own request was the second to reach /changing.png; a second download would be the third.
    expect(archived("image behind a redirect to a changing one", `${origin}/redirect.png`)).toBe("changing-2");
  });

  /** Catches a one-time or expiring URL going missing because only the page's own request succeeded. */
  it("archives an image the server answers only once", () => {
    expect(archived("image served only once", `${origin}/once.png`)).toBe("once-bytes");
    expect(run.output).not.toContain(`could not archive ${origin}/once.png`);
  });

  /** Catches the automatic snapshot firing while data the component fetches after render is in flight. */
  it("waits for data fetched after render, and the image it shows", () => {
    expect(run.snapshots.get("visual/network.capture.ts > image from data fetched after render")?.dom).toContain("late.png");
    expect(archived("image from data fetched after render", `${origin}/late.png`)).toBe("late-bytes");
  });

  /** Catches a request that never finishes failing the test or holding every later capture in the file,
   *  and one that hung in an earlier test switching off the wait for a later test's own request. */
  it("captures past a request that never finishes, warns once, and waits only for a test's own requests", () => {
    expect(run.snapshots.get("visual/network.capture.ts > request that never finishes")?.dom).toContain("streaming");
    expect(run.snapshots.get("visual/network.capture.ts > after a request that never finishes")?.dom).toContain("next");
    expect(run.failed.has("request that never finishes")).toBe(false);
    expect(run.output.split(`captured while ${origin}/never was still loading`)).toHaveLength(2);
    expect(run.durations.get("after a request that never finishes")).toBeLessThan(2_000);
    expect(run.snapshots.get("visual/network.capture.ts > a new request to a URL that never finished before")?.dom).toContain("again");
    expect(run.durations.get("a new request to a URL that never finished before")).toBeGreaterThan(4_500);
    expect(run.failed.has("a new request to a URL that never finished before")).toBe(false);
  });

  it("inlines a blob: image", () => {
    const dom = run.snapshots.get("visual/resources.capture.ts > blob image")?.dom ?? "";
    expect(dom).toContain("data:image/png;base64,");
    expect(dom).not.toContain("blob:");
  });
});

describe('a run with sequence.hooks: "list"', () => {
  /** Catches the hook placement assuming the default "stack" order, where the last-registered hook runs
   *  first. */
  it("still captures before the test file's cleanup", async () => {
    const run = await runFixture(["--sequence.hooks=list", "visual/hooks.capture.ts"]);
    expect(run.snapshots.get("visual/hooks.capture.ts > cleaned up after")?.dom).toContain("rendered");
  }, 180_000);
});

describe('a run with sequence.hooks: "parallel"', () => {
  /** Catches the setup-file hook, used where the capture can't run first, no longer capturing. */
  it("still captures each test", async () => {
    const run = await runFixture(["--sequence.hooks=parallel", "visual/hooks.capture.ts"]);
    expect(run.snapshots.has("visual/hooks.capture.ts > cleaned up after")).toBe(true);
  }, 180_000);
});

describe("a run with two browser projects capturing one file", () => {
  /** Catches the projects silently overwriting each other's captures in the shared archive folder. */
  it("warns that one capture per test is kept", async () => {
    const run = await runFixture(["visual/ids.capture.ts"], { UIVERIFY_E2E_SECOND_PROJECT: "1" });
    expect(run.output).toContain("browser projects into one archive folder");
  }, 180_000);
});

describe("a path-filtered run into an archive folder a previous run wrote", () => {
  /** Catches a filtered run keeping the previous run's captures, which the next upload would send as
   *  stale stories. */
  it("removes the previous run's captures", async () => {
    const outDir = tempDir();
    fs.mkdirSync(path.join(outDir, "snapshots"));
    fs.writeFileSync(path.join(outDir, "snapshots", "visual-old.capture.ts-a-0123456789.json"), JSON.stringify({ id: "visual/old.capture.ts > a" }));
    fs.mkdirSync(path.join(outDir, "resources"));
    fs.writeFileSync(path.join(outDir, "resources", "0".repeat(64)), "old");
    const run = await runFixture(["visual/ids.capture.ts"], {}, outDir);
    expect(run.snapshots.size).toBeGreaterThan(0);
    expect([...run.snapshots.keys()].filter((id) => !id.startsWith("visual/ids.capture.ts > "))).toEqual([]);
    expect(fs.existsSync(path.join(outDir, "resources", "0".repeat(64)))).toBe(false);
  }, 180_000);
});

describe("a run with networkIdleTimeout: 0", () => {
  /** Catches the option never reaching the capture, so a suite that turned the wait off still pays for it. */
  it("snapshots without waiting for the network", async () => {
    const run = await runFixture(["visual/network.capture.ts"], { UIVERIFY_E2E_IDLE_TIMEOUT: "0" });
    expect(run.snapshots.get("visual/network.capture.ts > image from data fetched after render")?.dom).not.toContain("late.png");
    expect(run.durations.get("a new request to a URL that never finished before")).toBeLessThan(2_000);
  }, 180_000);
});
