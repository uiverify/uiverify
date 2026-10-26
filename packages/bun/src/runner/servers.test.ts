import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listening, startServer } from "./servers";

const PORT = 15900 + Math.floor(Math.random() * 90);

/** A server that accepts connections at once, prints a line that merely contains its ready text, and its
 *  ready line only later, on stderr. */
const LATE_READY = `
Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("up") });
console.log("booting, not all set yet");
setTimeout(() => console.error("all set on :" + process.env.PORT), 400);
`;

describe("startServer", () => {
  /** Catches a server used as soon as its port accepts, before its data is in place. */
  test("is ready on a line starting with its ready text alone (either stream), not on the open port", async () => {
    const started = Date.now();
    const server = startServer([process.execPath, "-e", LATE_READY], PORT, { PORT: String(PORT) }, "all set");
    try {
      await server.ready;
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      expect(await listening(PORT)).toBe(true);
    } finally {
      await server.stop();
    }
    expect(await listening(PORT)).toBe(false);
  });

  test("without a ready line, is ready once its port accepts", async () => {
    const port = PORT + 9;
    const script = `setTimeout(() => Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("up") }), 300)`;
    const server = startServer([process.execPath, "-e", script], port, {});
    try {
      await server.ready;
      expect(await listening(port)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("a ready line with no newline after it counts", async () => {
    const port = PORT + 11;
    const script = `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("up") }); process.stdout.write("Listening on ${port}");`;
    const server = startServer([process.execPath, "-e", script], port, {}, "Listening");
    try {
      await server.ready;
    } finally {
      await server.stop();
    }
  });

  /** Catches a server that bound "localhost" as IPv6 only waiting out the 3-minute timeout. */
  test("a server listening on ::1 only fails at once, saying to listen on 127.0.0.1", async () => {
    const port = PORT + 13;
    const script = `Bun.serve({ port: ${port}, hostname: "::1", fetch: () => new Response("up") });`;
    const server = startServer([process.execPath, "-e", script], port, {});
    try {
      await expect(server.ready).rejects.toThrow(`listens on [::1]:${port} only; listen on 127.0.0.1`);
    } finally {
      await server.stop();
    }
  });

  test("a server that exits before it's ready fails the run, saying so", async () => {
    const server = startServer([process.execPath, "-e", "process.exit(3)"], PORT + 7, {}, "never printed");
    await expect(server.ready).rejects.toThrow(`the web server on :${PORT + 7} exited (3) before it was ready`);
    await server.stop();
  });

  /** Catches a pending ready timer or grace sleep holding the runner open after its servers are gone. */
  test("leaves nothing that keeps the process alive once stopped", async () => {
    const script = `
      import { startServer } from ${JSON.stringify(join(import.meta.dir, "servers.ts"))};
      const server = startServer([process.execPath, "-e", "setInterval(() => {}, 1000)"], ${PORT + 5}, {}, "never printed");
      server.ready.catch(() => {});
      await Bun.sleep(200);
      await server.stop();
    `;
    const started = Date.now();
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "inherit", stderr: "inherit" });
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
