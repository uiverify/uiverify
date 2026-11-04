import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { uiverifyPlugin } from "./plugin";

const servers: ViteDevServer[] = [];
const dirs: string[] = [];

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** A project whose installed `vitest` either exports `./browser` (Vitest 4/5) or doesn't (Vitest 3), next to
 *  the `@vitest/browser/context` module every one of those versions ships. */
function project(vitestExportsBrowser: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-resolve-"));
  dirs.push(root);
  const exportsMap: Record<string, string> = { ".": "./index.js" };
  if (vitestExportsBrowser) exportsMap["./browser"] = "./browser.js";
  write(root, "node_modules/vitest/package.json", JSON.stringify({ name: "vitest", exports: exportsMap }));
  write(root, "node_modules/vitest/index.js", "");
  write(root, "node_modules/vitest/browser.js", "");
  write(
    root,
    "node_modules/@vitest/browser/package.json",
    JSON.stringify({ name: "@vitest/browser", exports: { "./context": "./context.js" } }),
  );
  write(root, "node_modules/@vitest/browser/context.js", "");
  write(root, "src/capture.js", "");
  return root;
}

/** Resolve `vitest/browser` the way Vite does for the SDK's capture module, through the real plugin chain. */
async function resolveFrom(root: string): Promise<string | undefined> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [uiverifyPlugin({ outDir: path.join(root, "uiverify-archive") })],
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  servers.push(server);
  const resolved = await server.pluginContainer.resolveId("vitest/browser", path.join(root, "src/capture.js"));
  return resolved?.id;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("uiverifyPlugin resolving the browser API", () => {
  /** Catches the hook running after Vite's own resolver, which rejects the missing export before the
   *  fallback gets a chance, so the capture import fails on Vitest 3. */
  it("points vitest/browser at @vitest/browser/context when vitest has no ./browser export (Vitest 3)", async () => {
    const root = project(false);
    expect(await resolveFrom(root)).toBe(fs.realpathSync(path.join(root, "node_modules/@vitest/browser/context.js")));
  });

  /** Resolution only: in a real Vitest 4/5 run, Vitest's own plugin then serves this id as its browser module. */
  it("keeps vitest/browser when the installed vitest exports it", async () => {
    const root = project(true);
    expect(await resolveFrom(root)).toBe(fs.realpathSync(path.join(root, "node_modules/vitest/browser.js")));
  });
});

describe("uiverifyPlugin options", () => {
  /** The value the browser reads for `networkIdleTimeout`, from the config the plugin hands Vitest. */
  function providedTimeout(plugin: ReturnType<typeof uiverifyPlugin>): unknown {
    const config: unknown = typeof plugin.config === "function" ? Reflect.apply(plugin.config, plugin, [{}, {}]) : undefined;
    const test: unknown = typeof config === "object" && config ? Reflect.get(config, "test") : undefined;
    const provide: unknown = typeof test === "object" && test ? Reflect.get(test, "provide") : undefined;
    const ours: unknown = typeof provide === "object" && provide ? Reflect.get(provide, "__uiverify") : undefined;
    return typeof ours === "object" && ours ? Reflect.get(ours, "networkIdleTimeout") : undefined;
  }

  /** Catches `networkIdleTimeout` (`0` above all, which skips the wait) never reaching the browser; the e2e's
   *  run with it set to 0 checks the capture reads it. */
  it("hands networkIdleTimeout to the browser, 5 s unless set", () => {
    expect(providedTimeout(uiverifyPlugin())).toBe(5000);
    expect(providedTimeout(uiverifyPlugin({ networkIdleTimeout: 0 }))).toBe(0);
    expect(providedTimeout(uiverifyPlugin({ networkIdleTimeout: 1500 }))).toBe(1500);
  });
});
