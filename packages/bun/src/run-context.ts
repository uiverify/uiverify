import { readFileSync } from "node:fs";

/** Carries `<token>@<file>` from `run()` to each shard process: the file holds the shard's part of the
 *  run, and must carry the same token, so the variable can't be hand-set as configuration. */
export const RUN_ENV = "UIVERIFY_BUN_RUN";

export interface ShardContext {
  token: string;
  /** This process runs every `count`-th test × viewport entry of its file, starting at `index`. */
  shard: { index: number; count: number };
  baseUrl?: string;
}

function isShardContext(value: unknown): value is ShardContext {
  if (typeof value !== "object" || value === null) return false;
  const { token, shard, baseUrl } = Object.fromEntries(Object.entries(value));
  return (
    typeof token === "string" &&
    typeof shard === "object" &&
    shard !== null &&
    Number.isInteger(Reflect.get(shard, "index")) &&
    Number.isInteger(Reflect.get(shard, "count")) &&
    (baseUrl === undefined || typeof baseUrl === "string")
  );
}

/** The shard this process is, when `run()` started it; `undefined` for a direct `bun test`. */
export function readRunContext(env: Record<string, string | undefined> = process.env): ShardContext | undefined {
  const value = env[RUN_ENV];
  if (!value) return undefined;
  const at = value.indexOf("@");
  const token = value.slice(0, at);
  let context: unknown;
  try {
    context = JSON.parse(readFileSync(value.slice(at + 1), "utf8"));
  } catch {
    context = undefined;
  }
  if (at < 1 || !isShardContext(context) || context.token !== token) {
    throw new Error(`@uiverify/bun: ${RUN_ENV} is set by run() for the test processes it starts; don't set it yourself.`);
  }
  return context;
}
