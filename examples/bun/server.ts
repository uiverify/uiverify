import index from "./index.html";

// Bun bundles the page and its imports (TSX, CSS, fonts) itself. `run()` starts this with UI_VERIFY=1,
// which serves the production bundle, without the hot-reload client development mode injects.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { "/*": index },
  development: !process.env.UI_VERIFY,
});

console.log(`Listening on ${server.url}`);
