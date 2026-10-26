import { run } from "../../dist/run.js";

process.exitCode = await run({
  shards: { "pass.visual.ts": 2, "stateful.visual.ts": 2 },
  webServer: {
    command: ["bun", "server.ts"],
    port: Number(process.env.FIXTURE_PORT),
    // The runner's own PORT and UI_VERIFY win over a server's env.
    env: () => ({ UI_VERIFY: "0", PORT: "1" }),
    ready: "fixture ready",
    perShard: ["stateful.visual.ts"],
  },
});
