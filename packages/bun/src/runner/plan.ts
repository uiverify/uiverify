import { relative, resolve } from "node:path";

/** What a shard process takes at most: Chrome per shard is what exhausts a CI runner's memory. */
export const MEMORY_PER_SHARD = 768 * 1024 * 1024;

export interface WebServerOptions {
  /** The command that starts the app, e.g. `["bun", "server.ts"]`. A leading `"bun"` runs on the Bun that runs
   *  the tests. */
  command: string[];
  /** Server *i* listens on `port + 10 * i` (and may use the nine ports above it), on 127.0.0.1 or 0.0.0.0:
   *  the tests open `http://127.0.0.1:<port>`. */
  port: number;
  /** More environment for a server, by its port; `PORT` and `UI_VERIFY=1` are always set. */
  env?: (port: number) => Record<string, string>;
  /** How a line the server prints once it's ready to answer tests begins (stdout or stderr). Without one, ready
   *  is when the port accepts. */
  ready?: string;
  /** Files whose every shard gets a server of its own (a stateful file's shards must not share one). */
  perShard?: string[];
}

export interface RunOptions {
  /** How many processes each file splits into, by path. */
  shards?: Record<string, number>;
  webServer?: WebServerOptions;
}

export interface Args {
  files: string[];
  pattern?: string;
}

/** The runner's command line: test file paths, and `-t <pattern>` to run only matching tests. */
export function parseArgs(argv: string[]): Args {
  const files: string[] = [];
  let pattern: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-t") {
      const value = argv[++i];
      if (value === undefined) throw new Error("@uiverify/bun: -t needs a test name pattern");
      pattern = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`@uiverify/bun: unknown option ${arg}. The runner takes test file paths and -t <pattern>.`);
    } else files.push(arg);
  }
  return pattern === undefined ? { files } : { files, pattern };
}

export function normalizePath(cwd: string, path: string): string {
  return relative(cwd, resolve(cwd, path));
}

export interface ShardPlan {
  file: string;
  index: number;
  count: number;
  /** Which web server the shard's tests use. */
  server: number;
}

/** Every shard to run: shard *k* of a `perShard` file uses server *k*; every other file uses server 0. */
export function planShards(
  files: string[],
  discovered: string[],
  options: RunOptions,
): { shards: ShardPlan[]; servers: number } {
  const known = new Set(discovered);
  const keys = (record: Record<string, unknown> | string[]) => (Array.isArray(record) ? record : Object.keys(record));
  for (const key of [...keys(options.shards ?? {}), ...keys(options.webServer?.perShard ?? [])]) {
    if (!known.has(key)) throw new Error(`@uiverify/bun: run() names ${key}, which is not a *.visual.ts file here.`);
  }
  const perShard = new Set(options.webServer?.perShard ?? []);
  const shards: ShardPlan[] = [];
  let servers = 1;
  for (const file of files) {
    const count = options.shards?.[file] ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new Error(`@uiverify/bun: shards for ${file} must be a whole number ≥ 1`);
    if (perShard.has(file)) servers = Math.max(servers, count);
    for (let index = 0; index < count; index++) {
      shards.push({ file, index, count, server: perShard.has(file) ? index : 0 });
    }
  }
  return { shards, servers: options.webServer ? servers : 0 };
}

/** How many shard processes run at once. `constrained` is what a container allows: an unconstrained process
 *  can report a huge sentinel, so it is clamped to the machine's memory. */
export function shardSlots(total: number, constrained: number | undefined): number {
  const available = Math.min(constrained || total, total);
  return Math.max(1, Math.floor(available / MEMORY_PER_SHARD));
}
