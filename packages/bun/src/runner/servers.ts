import { createConnection } from "node:net";

const READY_TIMEOUT_MS = 180_000;
const STOP_GRACE_MS = 5_000;

export interface Server {
  url: string;
  ready: Promise<void>;
  stop(): Promise<void>;
}

/** Whether something accepts TCP connections on the port, at 127.0.0.1 (where the tests open it) unless told
 *  another host. */
export function listening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Start one web server in its own process group, stopped as a whole: a server script can exit before the
 * process it started has, and that one would keep the port. Ready once it prints a line (on stdout or stderr)
 * that starts with `readyLine`, and only then (a server can accept connections before its data is in place),
 * else once the port accepts.
 */
export function startServer(command: string[], port: number, env: Record<string, string>, readyLine?: string): Server {
  const child = Bun.spawn(command, {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let stopping = false;
  const ready = Promise.withResolvers<void>();
  const echo = async (stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let partial = "";
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const text = decoder.decode(read.value, { stream: true });
      out.write(text);
      if (readyLine === undefined) continue;
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      // The unfinished last line counts too: a banner may never get its newline.
      if ([...lines, partial].some((line) => line.trimStart().startsWith(readyLine))) ready.resolve();
    }
  };
  void echo(child.stdout, process.stdout);
  void echo(child.stderr, process.stderr);
  // Tests open http://127.0.0.1:<port>, so that's where the server must answer. One that listens only on
  // "localhost" can get IPv6 `::1` alone (macOS): say so, rather than wait out the timeout.
  void (async () => {
    while (!stopping && !(await listening(port))) {
      if (await listening(port, "::1")) {
        return ready.reject(
          new Error(`@uiverify/bun: the web server listens on [::1]:${port} only; listen on 127.0.0.1 (or 0.0.0.0), where the tests open it`),
        );
      }
      await Bun.sleep(100);
    }
    if (readyLine === undefined) ready.resolve();
  })();
  void child.exited.then((code) => {
    if (!stopping) ready.reject(new Error(`@uiverify/bun: the web server on :${port} exited (${code}) before it was ready`));
  });
  const timer = setTimeout(
    () => ready.reject(new Error(`@uiverify/bun: the web server on :${port} was not ready after ${READY_TIMEOUT_MS / 60_000} minutes`)),
    READY_TIMEOUT_MS,
  );
  void ready.promise.finally(() => clearTimeout(timer)).catch(() => {});
  return {
    url: `http://127.0.0.1:${port}`,
    ready: ready.promise,
    async stop() {
      stopping = true;
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-child.pid, name);
        } catch {
          // Already gone.
        }
      };
      clearTimeout(timer);
      signal("SIGTERM");
      // A timer, not Bun.sleep: a pending sleep would hold the process open after the server exits.
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([child.exited, new Promise((resolve) => (grace = setTimeout(resolve, STOP_GRACE_MS)))]);
      clearTimeout(grace);
      signal("SIGKILL");
      await child.exited;
    },
  };
}
