/**
 * `@uiverify/bun/run`: run the visual test files, each shard in its own `bun test` process with its own
 * Chrome, against the app's web servers, then write the archive's index for `uiverify upload`.
 *
 * Runs on any Bun from 1.3 (a project's `node_modules/.bin/bun` can be older than the one with
 * `Bun.WebView`): the test processes run on the launching Bun when it has `Bun.WebView`, else on the one
 * `bun run` was started with.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { clearArchive, finalizeArchive, resolveOutDir } from "@uiverify/archive-core";
import { RUN_ENV, type ShardContext } from "./run-context";
import { normalizePath, parseArgs, planShards, type RunOptions, shardSlots } from "./runner/plan";
import { listening, type Server, startServer } from "./runner/servers";

const TEST_TIMEOUT_MS = 60_000;

/** The Bun the test processes run on: this one if it has `Bun.WebView`, else the one `bun run` started. */
function testBun(): string {
  return typeof Reflect.get(Bun, "WebView") === "function" ? process.execPath : (process.env.npm_execpath ?? "bun");
}

function discover(cwd: string): string[] {
  return [...new Bun.Glob("**/*.visual.{ts,tsx}").scanSync({ cwd, onlyFiles: true })]
    .filter((path) => !path.split(/[\\/]/).includes("node_modules"))
    .map((path) => normalizePath(cwd, path))
    .sort();
}

/** Run the visual tests and resolve to an exit code: 0 when every shard passed. Never exits the process. */
export async function run(options: RunOptions = {}): Promise<number> {
  const started = performance.now();
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const discovered = discover(cwd);
  const files = args.files.length ? args.files.map((file) => normalizePath(cwd, file)) : discovered;
  // Nothing to run must not pass as a run that captured nothing (and cleared the last archive).
  if (!files.length) throw new Error(`@uiverify/bun: no *.visual.ts or *.visual.tsx files under ${cwd}`);
  const normalized: RunOptions = {
    shards: Object.fromEntries(Object.entries(options.shards ?? {}).map(([file, count]) => [normalizePath(cwd, file), count])),
    ...(options.webServer
      ? { webServer: { ...options.webServer, perShard: (options.webServer.perShard ?? []).map((file) => normalizePath(cwd, file)) } }
      : {}),
  };
  const plan = planShards(files, discovered, normalized);
  const outDir = resolveOutDir();
  const bun = testBun();

  const webServer = normalized.webServer;
  const ports = Array.from({ length: plan.servers }, (_, i) => (webServer?.port ?? 0) + 10 * i);
  for (const port of ports) {
    // A server left over from an interrupted run would answer instead of a fresh one.
    if ((await listening(port)) || (await listening(port, "::1"))) throw new Error(`@uiverify/bun: something is already listening on :${port}; stop it first.`);
  }

  clearArchive(outDir);
  const temp = mkdtempSync(join(tmpdir(), "uiverify-bun-"));
  // An empty config, so the app's `[test]` settings (a happy-dom preload replaces fetch) stay out of the
  // visual test processes.
  const bunfig = join(temp, "bunfig.toml");
  writeFileSync(bunfig, "");
  const token = randomUUID();

  const servers: Server[] = [];
  const children = new Set<Bun.Subprocess>();
  const cleanup = async () => {
    await Promise.all(servers.map((server) => server.stop()));
    rmSync(temp, { recursive: true, force: true });
  };

  const interrupted = Promise.withResolvers<number>();
  let stopped = false;
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = true;
    for (const child of children) child.kill(signal);
    void cleanup().then(() => interrupted.resolve(1));
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.on(signal, onSignal);

  const work = async (): Promise<number> => {
    for (const port of ports) {
      const [command = "", ...rest] = webServer?.command ?? [];
      const env = { ...webServer?.env?.(port), PORT: String(port), UI_VERIFY: "1" };
      servers.push(startServer([command === "bun" ? bun : command, ...rest], port, env, webServer?.ready));
    }
    await Promise.all(servers.map((server) => server.ready));
    const slots = shardSlots(totalmem(), process.constrainedMemory?.());
    const queue = [...plan.shards];
    let failed = false;
    const runShards = async () => {
      for (let shard = queue.shift(); shard && !stopped; shard = queue.shift()) {
        const context: ShardContext = {
          token,
          shard: { index: shard.index, count: shard.count },
          ...(servers[shard.server] ? { baseUrl: servers[shard.server]?.url } : {}),
        };
        const contextFile = join(temp, `${randomUUID()}.json`);
        writeFileSync(contextFile, JSON.stringify(context));
        const child = Bun.spawn(
          [
            bun,
            `--config=${bunfig}`,
            "test",
            `--timeout=${TEST_TIMEOUT_MS}`,
            // A shard none of whose tests match has nothing to run, which isn't a failure.
            ...(args.pattern === undefined ? [] : [`--test-name-pattern=${args.pattern}`, "--pass-with-no-tests"]),
            `./${shard.file}`,
          ],
          {
            env: { ...process.env, [RUN_ENV]: `${token}@${contextFile}`, UIVERIFY_ARCHIVE_DIR: outDir },
            stdout: "inherit",
            stderr: "inherit",
          },
        );
        children.add(child);
        if ((await child.exited) !== 0) failed = true;
        children.delete(child);
      }
    };
    await Promise.all(Array.from({ length: Math.min(slots, plan.shards.length) }, runShards));
    if (stopped) return 1;
    await cleanup();
    cleaned = true;
    // No test may have written anything, so the folder may not exist yet.
    mkdirSync(outDir, { recursive: true });
    const count = finalizeArchive(outDir);
    // Nothing captured by tests that all passed is a mistake (a typo'd -t, a file with no visual suite), not a
    // run to upload.
    if (count === 0 && !failed) {
      console.error(
        args.pattern === undefined
          ? "@uiverify/bun: the run captured no snapshots: no test was declared with a defineSuite() suite."
          : `@uiverify/bun: -t ${JSON.stringify(args.pattern)} matched no test.`,
      );
      return 1;
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const shown = relative(cwd, outDir);
    console.log(`Archived ${count} snapshots to ${shown.startsWith("..") ? outDir : shown || "."} in ${seconds}s`);
    return failed ? 1 : 0;
  };

  let cleaned = false;
  try {
    return await Promise.race([work(), interrupted.promise]);
  } catch (error) {
    // Whatever failed, no server may outlive the run.
    if (!cleaned) await cleanup();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}
