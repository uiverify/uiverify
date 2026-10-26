export interface ServeBundleOptions {
  /** The HTML entry (absolute path); the page that mounts the components a test captures. */
  entrypoint: string;
  /** `Bun.build` plugins, e.g. `bun-plugin-tailwind`. Not read from bunfig.toml. */
  plugins?: Bun.BunPlugin[];
  /** Compile-time constants. `Bun.build` inlines no env, so a `process.env.PUBLIC_*` the components read goes
   *  here. */
  define?: Record<string, string>;
}

/** Build `entrypoint` for the browser and serve the output on a free port, for component tests:
 *  `visualSuite(import.meta.path, { baseUrl: preview.url })`. */
export async function serveBundle({ entrypoint, plugins = [], define = {} }: ServeBundleOptions): Promise<{
  url: string;
  stop(): Promise<void>;
}> {
  const build = await Bun.build({ entrypoints: [entrypoint], target: "browser", plugins, define });
  if (!build.success) throw new AggregateError(build.logs, `@uiverify/bun: building ${entrypoint} failed`);
  const files = new Map(build.outputs.map((output) => [`/${output.path.replace(/^\.\//, "")}`, output]));
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      const file = files.get(pathname === "/" ? "/index.html" : pathname);
      return file ? new Response(file, { headers: { "content-type": file.type } }) : new Response(null, { status: 404 });
    },
  });
  // Forced: a graceful stop waits for Chrome's idle keep-alive connections, which it holds for seconds.
  return { url: server.url.origin, stop: () => server.stop(true) };
}
