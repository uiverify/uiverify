import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { type CapturedSnapshot, clearArchive, resolveOutDir, writeSnapshot } from "@uiverify/archive-core";
import { afterAll, describe as bunDescribe, test as bunTest } from "bun:test";
import pkg from "../package.json";
import { StaleTestError, testScope, type TestScope } from "./context";
import { checkSnapshotName, checkViewportKey, snapshotIds } from "./ids";
import { type Page, PageImpl } from "./page";
import { readRunContext } from "./run-context";
import { Tab, type Viewport } from "./tab";

/** Stamped into every snapshot so the CLI can report the capture SDK's version at upload; inlined at build. */
const PRODUCER = { name: pkg.name, version: pkg.version };

const DEFAULT_NOW = "2026-01-01T00:00:00Z";
const TEST_TIMEOUT_MS = 60_000;

/** Each entry runs a test once at that viewport. The `""` entry's snapshot keeps the test's own id; any other
 *  is suffixed `::<key>`. */
export type Viewports = Record<string, Viewport>;

/** What a suite, a `describe` or a test can set; a suite adds its own options next to these. */
export interface SuiteOptions {
  viewports: Viewports;
  /** Where the page clock starts, as an ISO date, in UTC unless it names an offset. Default
   *  `2026-01-01T00:00:00Z`. */
  now?: string;
  /** The page's `prefers-color-scheme`. Default `"light"`. */
  colorScheme?: "light" | "dark";
}

type Hook = (page: Page) => unknown;

interface Frame<Options> {
  name: string;
  options: Partial<Options>;
  beforeEach: Hook[];
}

/** The `describe`, `beforeEach` and `test` of one test file. */
export interface Suite<Options extends SuiteOptions> {
  describe(name: string, body: () => void): void;
  describe(name: string, options: Partial<Options>, body: () => void): void;
  /** Runs before each test of the enclosing `describe`, after the suite's setup. */
  beforeEach(hook: Hook): void;
  /** A visual test: `body` drives the page, and the test is snapshotted when it finishes unless it called
   *  `takeSnapshot()` itself. `overrides` replace the suite's and describes' options for this test. */
  test(name: string, body: (page: Page) => unknown, overrides?: Partial<Options>): void;
}

interface RunningTest extends TestScope {
  tab: Tab;
  path: string[];
  declaration: number;
  variant: string;
  viewport: Viewport;
  viewportKeys: string[];
  sourcePath: string;
  exclusive: boolean;
  /** Snapshots started, so a test that takes any isn't also snapshotted when it ends. */
  started: number;
  nameUses: Map<string, number>;
  pending: Set<Promise<unknown>>;
}

const runningTest = new AsyncLocalStorage<RunningTest>();

/** Clear the archive once per direct `bun test` process. Module state can't remember it: `bun test --isolate`
 *  gives each file fresh modules (and a fresh `process.env`), so the mark is a temp file named by the pid and
 *  holding the process's start time, which a later process that reuses the pid won't match. */
function clearArchiveOncePerProcess(outDir: string): void {
  const mark = join(tmpdir(), `uiverify-bun-cleared-${process.pid}`);
  const started = Date.now() - process.uptime() * 1000;
  try {
    const [time = "", dir] = readFileSync(mark, "utf8").split("\n");
    if (Math.abs(Number(time) - started) < 5_000 && dir === outDir) return;
  } catch {
    // No mark: this process hasn't cleared it yet.
  }
  clearArchive(outDir);
  writeFileSync(mark, `${started}\n${outDir}`);
}

function assertNativeFetch(): void {
  if (!Function.prototype.toString.call(globalThis.fetch).includes("[native code]")) {
    throw new Error(
      "@uiverify/bun: globalThis.fetch has been replaced (a test preload such as happy-dom?). The visual tests " +
        "need Bun's own fetch: run them with run() from @uiverify/bun/run, which ignores the app's bunfig.toml.",
    );
  }
}

/** `now` as epoch ms, read as UTC unless it names an offset: the page runs in UTC, and Bun's `Date.parse`
 *  would read a date-time without one in the machine's own zone, so a Mac and CI would start apart. */
export function parseNow(now: string): number {
  const hasTime = /\d[T ]\d/.test(now);
  const time = Date.parse(!hasTime || /([zZ]|[+-]\d\d(:?\d\d)?)$/.test(now) ? now : `${now.replace(" ", "T")}Z`);
  if (Number.isNaN(time)) throw new Error(`@uiverify/bun: now: ${JSON.stringify(now)} is not a date Date.parse reads.`);
  return time;
}

async function snapshot(running: RunningTest, name: string): Promise<string> {
  const use = (running.nameUses.get(name) ?? 0) + 1;
  running.nameUses.set(name, use);
  const ids = snapshotIds(running, name, use);
  try {
    const page = await running.tab.capture(ids.id);
    running.tab.assertCurrent("takeSnapshot()");
    const captured: CapturedSnapshot = {
      ...ids,
      viewport: running.viewport,
      ...page,
      producer: PRODUCER,
      sourcePath: running.sourcePath,
    };
    writeSnapshot(resolveOutDir(), captured, { exclusive: running.exclusive });
    return ids.id;
  } catch (error) {
    // Nothing was written under the id, so a retry of the same name takes it.
    running.nameUses.set(name, use - 1);
    throw error;
  }
}

function notAwaited(count: number): Error {
  return new Error(
    `@uiverify/bun: ${count} takeSnapshot() call${count === 1 ? " was" : "s were"} not awaited. Write \`await takeSnapshot(...)\`.`,
  );
}

/** Archive the current test's page as a snapshot and return its id. A `name` tells several snapshots of one
 *  test apart; a test that takes none is snapshotted once when it ends. */
export async function takeSnapshot(name = ""): Promise<string> {
  const running = runningTest.getStore();
  if (!running) {
    throw new Error(
      "@uiverify/bun: takeSnapshot() was called outside a visual test. Call it in a test from your defineSuite() suite.",
    );
  }
  checkSnapshotName(name, running.viewportKeys);
  running.started++;
  const capturing = snapshot(running, name);
  running.pending.add(capturing);
  try {
    return await capturing;
  } finally {
    running.pending.delete(capturing);
  }
}

/**
 * Define the visual tests' suite: `defaults` are the options every test starts from, and `setup` runs at the
 * start of every test (suite-wide routes, init scripts). Returns a function each test file calls with its own
 * path (`import.meta.path`) and, optionally, the base URL its relative `goto`s and routes resolve against
 * (else the runner's web server).
 */
export function defineSuite<Options extends SuiteOptions>(
  defaults: Options,
  setup?: (page: Page, options: Options) => unknown,
): (file: string, options?: { baseUrl?: string }) => Suite<Options> {
  return (file, { baseUrl } = {}) => {
    if (process.env.BUN_TEST_WORKER_ID !== undefined) {
      throw new Error(
        "@uiverify/bun: visual tests can't run under bun test --parallel: each file drives one browser tab, one " +
          "test at a time. run() from @uiverify/bun/run runs files in parallel itself.",
      );
    }
    assertNativeFetch();
    const context = readRunContext();
    // A direct `bun test` is the whole run, so it starts from an empty archive, as each Vitest run does.
    if (!context) clearArchiveOncePerProcess(resolveOutDir());
    const shard = context?.shard ?? { index: 0, count: 1 };
    const tab = new Tab(baseUrl ?? context?.baseUrl);
    const page = new PageImpl(tab);
    afterAll(() => tab.close());

    const fileName = basename(file);
    const sourcePath = relative(process.cwd(), file);
    const stack: Frame<Options>[] = [];
    const declarations = new Map<string, number>();
    let declared = 0;

    function describe(name: string, a: Partial<Options> | (() => void), b?: () => void): void {
      const body = typeof a === "function" ? a : b;
      const options = typeof a === "function" ? {} : a;
      // bun:test runs a nested describe's body after its parent's, so each body restores the path it was
      // declared under.
      const path = [...stack, { name, options, beforeEach: [] }];
      bunDescribe(name, () => {
        const outer = stack.splice(0, stack.length, ...path);
        body?.();
        stack.splice(0, stack.length, ...outer);
      });
    }

    function beforeEach(hook: Hook): void {
      const frame = stack.at(-1);
      if (!frame) throw new Error("@uiverify/bun: beforeEach() belongs inside a describe()");
      frame.beforeEach.push(hook);
    }

    function test(name: string, body: (page: Page) => unknown, overrides: Partial<Options> = {}): void {
      const frames = [...stack];
      const path = [fileName, ...frames.map((frame) => frame.name), name];
      const key = path.join(" > ");
      const declaration = (declarations.get(key) ?? 0) + 1;
      declarations.set(key, declaration);
      const merged = frames.reduce<Options>((options, frame) => ({ ...options, ...frame.options }), defaults);
      const options: Options = { ...merged, ...overrides };
      const viewportKeys = Object.keys(options.viewports);
      if (!viewportKeys.length) throw new Error(`@uiverify/bun: "${key}" has no viewports, so it would never run.`);
      for (const viewportKey of viewportKeys) checkViewportKey(viewportKey);
      const now = parseNow(options.now ?? DEFAULT_NOW);
      const colorScheme = options.colorScheme ?? "light";

      for (const [variant, viewport] of Object.entries(options.viewports)) {
        if (declared++ % shard.count !== shard.index) continue;
        const run = async () => {
          const generation = await tab.begin({ viewport, now, colorScheme });
          const running: RunningTest = {
            generation,
            tab,
            path,
            declaration,
            variant,
            viewport,
            viewportKeys,
            sourcePath,
            exclusive: context !== undefined,
            started: 0,
            nameUses: new Map(),
            pending: new Set(),
          };
          try {
            await testScope.run(running, () => runningTest.run(running, () => runBody(running, body, frames, options)));
          } catch (error) {
            // bun:test already failed this test for its timeout, and what it reads now is the next test's
            // page: it's no error between tests.
            if (!(error instanceof StaleTestError) && generation === tab.generation) throw error;
          }
        };
        // Serial even under `bun test --concurrent`: every test of the file drives its one tab.
        bunTest.serial(variant ? `${name} (${variant})` : name, run, TEST_TIMEOUT_MS);
      }
    }

    async function runBody(
      running: RunningTest,
      body: (page: Page) => unknown,
      frames: Frame<Options>[],
      options: Options,
    ): Promise<void> {
      let failure: { error: unknown } | undefined;
      try {
        await setup?.(page, options);
        for (const frame of frames) for (const hook of frame.beforeEach) await hook(page);
        await body(page);
      } catch (error) {
        failure = { error };
      }
      if (running.pending.size) {
        const count = running.pending.size;
        await Promise.allSettled(running.pending);
        failure ??= { error: notAwaited(count) };
      }
      // A failed test is snapshotted too, so a local check shows what the failing page looked like.
      if (running.started === 0) {
        try {
          await snapshot(running, "");
        } catch (error) {
          failure ??= { error };
        }
      }
      // What broke on the page explains a failure it caused (a route that threw shows up as a load that
      // failed, or an element that never came), and fails a test that otherwise passed after its snapshot.
      const pageErrors = running.tab.pageErrors();
      if (pageErrors && !(failure?.error instanceof Error && failure.error.message.includes(pageErrors))) {
        if (!failure) throw new Error(pageErrors);
        const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
        throw new Error(`${pageErrors}\n\nThe test failed with: ${message}`, { cause: failure.error });
      }
      if (failure) throw failure.error;
    }

    return { describe, beforeEach, test };
  };
}
