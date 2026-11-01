import { run } from "@uiverify/bun/run";

// `bun tests/visual/run.ts [files…] [-t <name pattern>]`: starts the app, runs every *.visual.ts in its own
// `bun test` process, and writes uiverify-archive/ for `uiverify upload`.
process.exitCode = await run({
  webServer: { command: ["bun", "server.ts"], port: 4400, ready: "Listening" },
});
