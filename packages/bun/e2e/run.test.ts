import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchivedSnapshot, ArchiveIndex } from "@uiverify/archive-core";

/**
 * Builds the package, then drives the fixture app in `e2e/fixture` through `run()` from the built `dist/`, in
 * real Chrome, and checks what each run printed and archived. The only test of the page script, the tab
 * driver and the runner together.
 */

const packageDir = join(import.meta.dir, "..");
const hasParallel = Bun.spawnSync([process.execPath, "test", "--help"]).stdout.toString().includes("--parallel");
const fixture = join(import.meta.dir, "fixture");
const E2E_TIMEOUT_MS = 240_000;
let nextPort = 14700 + Math.floor(Math.random() * 50) * 10;

interface Run {
  code: number;
  output: string;
  outDir: string;
  index: ArchiveIndex;
  snapshots: Map<string, ArchivedSnapshot>;
}

async function runFixture(...args: string[]): Promise<Run> {
  const outDir = mkdtempSync(join(tmpdir(), "uiverify-bun-e2e-"));
  nextPort += 10;
  const child = Bun.spawn([process.execPath, "run.ts", ...args], {
    cwd: fixture,
    env: { ...process.env, FIXTURE_PORT: String(nextPort), UIVERIFY_ARCHIVE_DIR: outDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const index: ArchiveIndex = existsSync(join(outDir, "index.json"))
    ? JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"))
    : { v: 1, entries: {} };
  const snapshots = new Map<string, ArchivedSnapshot>();
  for (const file of existsSync(join(outDir, "snapshots")) ? readdirSync(join(outDir, "snapshots")) : []) {
    const snapshot: ArchivedSnapshot = JSON.parse(readFileSync(join(outDir, "snapshots", file), "utf8"));
    snapshots.set(snapshot.id, snapshot);
  }
  return { code, output: stdout + stderr, outDir, index, snapshots };
}

const dom = (run: Run, id: string) => {
  const snapshot = run.snapshots.get(id);
  if (!snapshot) throw new Error(`no snapshot ${id}; have ${[...run.snapshots.keys()].join(", ")}`);
  return JSON.stringify(snapshot.dom);
};

beforeAll(async () => {
  const build = Bun.spawnSync(["pnpm", "build"], { cwd: packageDir, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error("building @uiverify/bun failed");
});

describe("a passing run", () => {
  let run: Run;
  beforeAll(async () => {
    run = await runFixture("pass.visual.ts", "sequence.visual.ts", "stateful.visual.ts", "bundle.visual.ts");
  }, E2E_TIMEOUT_MS);

  test("every test passed, across two shards, and the index lists each snapshot once", () => {
    expect(run.output).not.toContain("(fail)");
    expect(run.output).not.toContain("could not archive");
    expect(run.code).toBe(0);
    expect(run.output).toMatch(/Archived 56 snapshots to .+ in [\d.]+s/);
    expect(Object.keys(run.index.entries).sort()).toEqual([...run.snapshots.keys()].sort());
    expect(run.index.producer?.name).toBe("@uiverify/bun");
  });

  /** Catches an id, title, name or viewport drifting from the shape baselines are keyed by. */
  test("ids, titles, names and viewports", () => {
    const at = (id: string) => {
      const snapshot = run.snapshots.get(id);
      return snapshot && { title: snapshot.title, name: snapshot.name, viewport: snapshot.viewport };
    };
    expect(at("pass.visual.ts > Captures > two viewports and a named snapshot::named")).toEqual({
      title: "pass.visual.ts > Captures > two viewports and a named snapshot",
      name: "named",
      viewport: { width: 800, height: 600 },
    });
    expect(at("pass.visual.ts > Captures > two viewports and a named snapshot::named::mobile")).toEqual({
      title: "pass.visual.ts > Captures > two viewports and a named snapshot",
      name: "named (mobile)",
      viewport: { width: 390, height: 844 },
    });
    expect(at("pass.visual.ts > Locators > concurrent click and fill both land")).toEqual({
      title: "pass.visual.ts > Locators",
      name: "",
      viewport: { width: 1280, height: 800 },
    });
    expect(run.snapshots.get("pass.visual.ts > Locators > concurrent click and fill both land")?.sourcePath).toBe("pass.visual.ts");
    expect(run.snapshots.has("sequence.visual.ts > Sequence > the next test starts clean")).toBe(true);
  });

  /** Catches UI_VERIFY unset on the server, or overridden by the server's own env. */
  test("the server gets UI_VERIFY=1, whatever its env says", () => {
    const home = dom(run, "sequence.visual.ts > Sequence > a load left hanging");
    expect(home).toContain("Fixture home");
    expect(home).toContain('"data-ui-verify":"1"');
  });

  /** Catches a click scrolling the target to the centre (every overlay it opens moves) instead of minimally. */
  test("a click below the fold scrolls minimally", () => {
    expect(dom(run, "pass.visual.ts > Locators > a click below the fold scrolls only as far as it must")).toContain(
      '"data-scroll-y":"1248"',
    );
  });

  test("routes answer, init scripts run, and a never-answered request leaves a capturable loading state", () => {
    const routed = dom(run, "pass.visual.ts > Routes and scripts > a route answers and an init script runs first");
    expect(routed).toContain("routed item");
    expect(routed).toContain('"textContent":"ran"');
    expect(dom(run, "pass.visual.ts > Routes and scripts > a never-answered request leaves the page loading, and it can be captured")).toContain("Loading…");
  });

  /** Catches what a resource's replay needs going missing: each kind of asset a real page loads. */
  test("archives css-referenced fonts and backgrounds, images, a lazy image, cross-origin assets, and inlines a blob", () => {
    const snapshot = run.snapshots.get("pass.visual.ts > Resources > css, images, fonts, a background, a lazy image, cross-origin assets and a blob");
    const urls = Object.keys(snapshot?.resources ?? {}).map((url) => new URL(url).pathname).sort();
    expect(urls).toEqual(["/bg.png", "/cross-font.ttf", "/cross.css", "/cross.png", "/font.ttf", "/lazy.png", "/red.png", "/redirect.png"]);
    const text = JSON.stringify(snapshot?.dom);
    expect(text).toContain('"loading":"lazy"');
    expect(text).toContain('"src":"data:image/png;base64,');
    expect(text).not.toContain("blob:");
    expect(text).not.toContain("data-vt-ref");
  });

  /** Catches the received-bytes channel archiving a stale, earlier answer of a URL the page loaded again. */
  test("a URL the page loaded twice is archived as it last answered", () => {
    const snapshot = run.snapshots.get("pass.visual.ts > API > a URL the page loaded twice is archived as it last answered");
    const entry = Object.entries(snapshot?.resources ?? {}).find(([url]) => url.endsWith("/changing.png"));
    const blue = readFileSync(join(fixture, "assets/blue.png"));
    expect(entry && readFileSync(join(run.outDir, entry[1].file)).equals(blue)).toBe(true);
  });

  /** Catches an earlier routed answer outliving a later load the route left to the network. */
  test("a URL routed once, then left to the network, is archived as the network answered", () => {
    const snapshot = run.snapshots.get("pass.visual.ts > API > a URL routed once, then left to the network, is archived as the network answered");
    const entry = Object.entries(snapshot?.resources ?? {}).find(([url]) => url.endsWith("/routed-once.png"));
    const red = readFileSync(join(fixture, "assets/red.png"));
    expect(entry && readFileSync(join(run.outDir, entry[1].file)).equals(red)).toBe(true);
  });

  /** Catches the capture stripping a `data-vt-ref` the app set itself, or leaving an SDK mark on a copy the
   *  app made of a marked element. */
  test("an app's own data-vt-ref survives the capture, and the SDK's marks don't", () => {
    const text = dom(run, "pass.visual.ts > API > an app's own data-vt-ref survives the capture");
    expect(text).toContain('"data-vt-ref":"app-owned"');
    expect(text).toContain('"data-vt-ref":"1"');
    expect(text.match(/data-vt-ref/g)?.length).toBe(2);
  });

  /** Catches a mark surviving on an element, or a copy of one, that the app held detached while a capture
   *  cleared the marks (a cached panel). */
  test("a mark on an element the app detached during a capture doesn't outlive it", () => {
    const text = dom(run, "pass.visual.ts > API > a mark on an element the app detached during a capture doesn't outlive it::panel back");
    expect(text).toContain("Panel text");
    expect(text).toContain("held-copy");
    expect(text).not.toContain("uiverify-");
  });

  /** Catches an asset being stored once per snapshot instead of once per archive. */
  test("a resource used by several snapshots is stored once", () => {
    const files = new Set<string>();
    let uses = 0;
    for (const snapshot of run.snapshots.values()) {
      for (const [url, resource] of Object.entries(snapshot.resources)) {
        if (!url.endsWith("/cross.png")) continue;
        uses++;
        files.add(resource.file);
      }
    }
    expect(uses).toBeGreaterThan(1);
    expect(files.size).toBe(1);
    expect(readdirSync(join(run.outDir, "resources")).length).toBeGreaterThan(0);
  });

  test("Math.random is seeded: the same in two tests", () => {
    const random = (id: string) => /"id":"random"[^]*?"textContent":"([\d.]+)"/.exec(dom(run, id))?.[1];
    const first = random("pass.visual.ts > Resources > seeded Math.random, the same in every test");
    expect(first).toMatch(/^0\.\d+$/);
    expect(random("pass.visual.ts > Resources > seeded Math.random, again")).toBe(first);
  });

  test("a describe's now applies on a second document, and colorScheme dark flips matchMedia and the snapshot", () => {
    expect(dom(run, "pass.visual.ts > Options > a describe's now, on a second document")).toContain('"textContent":"2030-06-01T12:00:0');
    expect(dom(run, "pass.visual.ts > Scheme > dark")).toContain('"textContent":"dark"');
    expect(run.snapshots.get("pass.visual.ts > Scheme > dark")?.colorScheme).toBe("dark");
    expect(run.snapshots.get("pass.visual.ts > Locators > concurrent click and fill both land")?.colorScheme).toBe("light");
  });

  /** Catches the channel reading anything but the visual assets Chrome loaded for this page. */
  test("the outside-page channel refuses files, addresses the page never loaded, and non-visual bodies", () => {
    expect(dom(run, "pass.visual.ts > Routes and scripts > the outside-page channel only hands back visual assets Chrome loaded")).toContain(
      JSON.stringify(
        JSON.stringify({
          "loaded image": "bytes",
          file: "refused",
          metadata: "refused",
          "never loaded": "refused",
          "json via img": "refused",
          "json via no-cors fetch": "refused",
        }),
      ).slice(1, -1),
    );
  });

  /** Catches a renumbering that would move existing baselines: repeats and nesting through the real suite. */
  test("repeated declarations get (2), a repeated name #2, and nested describes keep their path", () => {
    for (const id of [
      "pass.visual.ts > API > declared twice",
      "pass.visual.ts > API > declared twice (2)",
      "pass.visual.ts > API > a repeated name gets #2::same",
      "pass.visual.ts > API > a repeated name gets #2::same #2",
      "pass.visual.ts > API > Outer > Inner > deep",
      "pass.visual.ts > API > Outer > after the inner describe",
    ]) {
      expect(run.snapshots.has(id)).toBe(true);
    }
  });

  test("a test's own options override the suite's", () => {
    const snapshot = run.snapshots.get("pass.visual.ts > API > per-test overrides");
    expect([snapshot?.viewport, snapshot?.colorScheme]).toEqual([{ width: 500, height: 400 }, "dark"]);
    expect(dom(run, "pass.visual.ts > API > per-test overrides")).toContain('"textContent":"dark"');
  });

  test("addStyleTag's style is in the page, and a paused clock stands still", () => {
    expect(dom(run, "pass.visual.ts > API > addStyleTag, a waitUntil timeout, and locator assertions counted by expect.assertions")).toContain(
      "rgb(1, 2, 3)",
    );
    const stamps = Array.from(
      dom(run, "pass.visual.ts > API > a paused clock holds timers and Date until it resumes").matchAll(/"textContent":"(\d{13})"/g),
      (match) => match[1],
    );
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(stamps[1]);
  });

  /** Catches a change to the dealing (a stateful suite relies on which shard gets which test) or a perShard
   *  shard sharing server 0. */
  test("each test × viewport entry is dealt to the shards in turn, and a perShard shard uses its own server", () => {
    const port = (id: string) => /"textContent":"port (\d+)"/.exec(dom(run, id))?.[1];
    const ports = ["first", "first::mobile", "second", "third"].map((name) => port(`stateful.visual.ts > ${name}`));
    expect(new Set(ports).size).toBe(2);
    expect(Number(ports[1]) - Number(ports[0])).toBe(10);
    expect(ports).toEqual([ports[0], ports[1], ports[0], ports[1]]);
  });

  test("a shadow root's marks don't reach the archive", () => {
    expect(dom(run, "pass.visual.ts > API > a role locator inside a shadow root is visible and clickable")).not.toContain("data-vt-ref");
  });

  test("serveBundle builds and serves a component page, with its CSS and defines", () => {
    const page = dom(run, "bundle.visual.ts > a component page");
    expect(page).toContain("Hello from define and a plugin");
    expect(page).toContain("rgb(10, 20, 30)");
  });
});

describe("a run with failing tests", () => {
  let run: Run;
  beforeAll(async () => {
    run = await runFixture("fails.visual.ts");
  }, E2E_TIMEOUT_MS);

  test("each failure fails its test, saying why", () => {
    expect(run.code).toBe(1);
    expect(run.output).toContain("the page reported errors:\nUncaught Error: the page broke");
    expect(run.output).toContain("GET http://127.0.0.1:");
    expect(run.output).toContain("no answer recorded");
    expect(run.output).toContain("1 takeSnapshot() call was not awaited");
    expect(run.output).toContain('the snapshot name "a::b" contains "::"');
    expect(run.output).toContain('the snapshot name "mobile" is also one of this test\'s viewport keys');
    expect(run.output).toContain("Uncaught (in promise) Error: an unhandled rejection");
    expect(run.output).toContain("Uncaught Error: timer threw");
    expect(run.output).toMatch(/the page reported errors:\nGET http:\/\/127\.0\.0\.1:\d+\/routed \(route \*\*\/routed\): the document route broke\n\nThe test failed with: net::ERR_FAILED/);
    expect(run.output).not.toContain('getByText("Second timer ran")');
    expect(run.output).toContain("the page never stopped changing within 10s (<div#spinner> kept changing)");
  });

  test("the next test is intact, and a failed test whose page broke writes nothing", () => {
    expect(run.snapshots.has("fails.visual.ts > Failures > after the failures, a test is intact")).toBe(true);
    expect(run.snapshots.has("fails.visual.ts > Failures > after the failures, a test is intact::mobile")).toBe(true);
    expect(run.snapshots.has("fails.visual.ts > Failures > a page error fails its test")).toBe(false);
    expect(run.snapshots.has("fails.visual.ts > Failures > an error on an earlier document of the test fails it")).toBe(false);
    expect(run.snapshots.has("fails.visual.ts > Failures > an unhandled rejection fails its test")).toBe(false);
  });
});

describe("-t", () => {
  test("runs only the tests whose names match", async () => {
    // One matching test: the other shard has none, which must not fail the run.
    const run = await runFixture("pass.visual.ts", "-t", "a describe's now");
    expect(run.code).toBe(0);
    expect([...run.snapshots.keys()]).toEqual(["pass.visual.ts > Options > a describe's now, on a second document"]);
  }, E2E_TIMEOUT_MS);
});

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

describe("-t matching nothing", () => {
  /** Catches a typo'd pattern passing as a run that captured nothing. */
  test("fails, saying so", async () => {
    const run = await runFixture("pass.visual.ts", "-t", "no test is called this");
    expect(run.code).toBe(1);
    expect(run.output).toContain('-t "no test is called this" matched no test');
  }, E2E_TIMEOUT_MS);
});

describe("discovery", () => {
  /** Catches run() missing a project's visual tests, or running a dependency's. */
  test("runs every *.visual.ts and *.visual.tsx outside node_modules", () => {
    const project = mkdtempSync(join(tmpdir(), "uiverify-bun-discover-"));
    const index = JSON.stringify(join(packageDir, "dist/index.js"));
    const visual = (name: string) =>
      `import { defineSuite } from ${index};\nconst { test } = defineSuite({ viewports: { "": { width: 10, height: 10 } } })(import.meta.path);\ntest(${JSON.stringify(name)}, async () => {});\n`;
    writeFileSync(join(project, "a.visual.ts"), visual("a"));
    mkdirSync(join(project, "nested"));
    writeFileSync(join(project, "nested/b.visual.tsx"), visual("b"));
    mkdirSync(join(project, "node_modules/dep"), { recursive: true });
    writeFileSync(join(project, "node_modules/dep/c.visual.ts"), 'throw new Error("a dependency\'s test ran");\n');
    const script = `import { run } from ${JSON.stringify(join(packageDir, "dist/run.js"))}; process.exitCode = await run();`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(result.stdout.toString() + result.stderr.toString()).toContain("Archived 2 snapshots");
    expect(result.exitCode).toBe(0);
  }, E2E_TIMEOUT_MS);
});

describe("an interrupted run", () => {
  /** Catches Ctrl-C leaving the app's server (its own process group) running and holding the port. */
  test("stops its servers and exits 1 without an index", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "uiverify-bun-e2e-"));
    nextPort += 10;
    const port = nextPort;
    const child = Bun.spawn([process.execPath, "run.ts", "sequence.visual.ts"], {
      cwd: fixture,
      env: { ...process.env, FIXTURE_PORT: String(port), UIVERIFY_ARCHIVE_DIR: outDir },
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("fixture ready")) {
      const read = await reader.read();
      if (read.done) break;
      seen += new TextDecoder().decode(read.value);
    }
    expect(await listening(port)).toBe(true);
    child.kill("SIGINT");
    expect(await child.exited).toBe(1);
    expect(await listening(port)).toBe(false);
    expect(existsSync(join(outDir, "index.json"))).toBe(false);
  }, E2E_TIMEOUT_MS);
});

describe("a port already in use", () => {
  /** Catches a server left over from an earlier run answering the tests, on either loopback address. */
  test("fails the run before it starts, on 127.0.0.1 or ::1", async () => {
    for (const hostname of ["127.0.0.1", "::1"]) {
      const port = nextPort + 10;
      const leftover = Bun.serve({ hostname, port, fetch: () => new Response("leftover") });
      try {
        const run = await runFixture("other.visual.ts");
        expect(run.code).toBe(1);
        expect(run.output).toContain(`something is already listening on :${port}`);
      } finally {
        await leftover.stop(true);
      }
    }
  }, E2E_TIMEOUT_MS);
});

describe("two files with the same name", () => {
  /** Catches one silently overwriting the other's snapshot. */
  test("fail the run", async () => {
    const run = await runFixture("dup/a/same.visual.ts", "dup/b/same.visual.ts");
    expect(run.code).toBe(1);
    expect(run.output).toContain('Two tests produced the snapshot id "same.visual.ts > same"');
  }, E2E_TIMEOUT_MS);
});

describe("a run that captures nothing", () => {
  /** Catches a visual file with no suite passing as a run to upload. */
  test("fails, saying why", () => {
    const project = mkdtempSync(join(tmpdir(), "uiverify-bun-nothing-"));
    writeFileSync(join(project, "plain.visual.ts"), 'import { test } from "bun:test";\ntest("not visual", () => {});\n');
    const script = `import { run } from ${JSON.stringify(join(packageDir, "dist/run.js"))}; process.exitCode = await run();`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("the run captured no snapshots");
  });
});

describe("a run with nothing to run", () => {
  /** Catches an empty project passing as a run that captured nothing (and clearing the last archive). */
  test("fails, saying so", () => {
    const empty = mkdtempSync(join(tmpdir(), "uiverify-bun-empty-"));
    const script = `import { run } from ${JSON.stringify(join(packageDir, "dist/run.js"))}; process.exitCode = await run();`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: empty, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("no *.visual.ts or *.visual.tsx files");
  });
});

describe("a direct bun test", () => {
  /** Catches each file of an `--isolate` run clearing the archive, deleting the files before it. */
  test("with --isolate, keeps every file's snapshots", () => {
    const outDir = mkdtempSync(join(tmpdir(), "uiverify-bun-e2e-"));
    const config = join(outDir, "bunfig.toml");
    writeFileSync(config, "");
    const direct = Bun.spawnSync(
      [process.execPath, `--config=${config}`, "test", "--isolate", "./concurrent.visual.ts", "./other.visual.ts"],
      { cwd: fixture, env: { ...process.env, UIVERIFY_ARCHIVE_DIR: outDir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(direct.exitCode).toBe(0);
    const snapshots = readdirSync(join(outDir, "snapshots"));
    expect(snapshots.length).toBe(4);
    // On the blank page a test that never navigates captures, animations are finished too.
    expect(readFileSync(join(outDir, "snapshots", snapshots[0] ?? ""), "utf8")).toContain("animation-duration: 0s");
  });

  /** Catches `--concurrent` running a file's tests at once on its one tab. */
  test("with --concurrent, still runs a suite's tests one at a time", () => {
    const outDir = mkdtempSync(join(tmpdir(), "uiverify-bun-e2e-"));
    const config = join(outDir, "bunfig.toml");
    writeFileSync(config, "");
    const direct = Bun.spawnSync([process.execPath, `--config=${config}`, "test", "--concurrent", "./concurrent.visual.ts"], {
      cwd: fixture,
      env: { ...process.env, UIVERIFY_ARCHIVE_DIR: outDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = direct.stdout.toString() + direct.stderr.toString();
    expect(output).toContain(" 3 pass");
    expect(direct.exitCode).toBe(0);
  });

  /** Catches visual files running across `--parallel` workers, sharing one archive with nothing to say so.
   *  Only on a Bun that has `--parallel` (1.4+): an older one runs the files one after another. */
  test.skipIf(!hasParallel)("with --parallel, fails at once saying why", () => {
    const outDir = mkdtempSync(join(tmpdir(), "uiverify-bun-e2e-"));
    const config = join(outDir, "bunfig.toml");
    writeFileSync(config, "");
    const direct = Bun.spawnSync(
      [process.execPath, `--config=${config}`, "test", "--parallel=2", "./concurrent.visual.ts", "./other.visual.ts"],
      { cwd: fixture, env: { ...process.env, UIVERIFY_ARCHIVE_DIR: outDir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr.toString() + direct.stdout.toString()).toContain("visual tests can't run under bun test --parallel");
  });

  /** Catches the app's bunfig preload (happy-dom replacing fetch) silently breaking captures. */
  test("under the app's bunfig, fails at once naming the replaced fetch", () => {
    const direct = Bun.spawnSync([process.execPath, "test", "./pass.visual.ts"], { cwd: fixture, stdout: "pipe", stderr: "pipe" });
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr.toString() + direct.stdout.toString()).toContain("globalThis.fetch has been replaced");
  });
});
