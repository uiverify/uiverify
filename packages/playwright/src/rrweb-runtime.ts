import fs from "node:fs";
import { createRequire } from "node:module";

/**
 * The rrweb-snapshot UMD bundle source, read from this package's own dependency and cached.
 *
 * rrweb-snapshot's `snapshot()` runs IN THE BROWSER, so we inject this bundle into the page during a
 * test rather than importing it in Node. UI Verify's replay side reads the same rrweb-snapshot version
 * to `rebuild()` the DOM, so producer and consumer must stay on a matching version (a serialize/rebuild
 * mismatch would silently corrupt replays) — pin `rrweb-snapshot` accordingly.
 * The UMD assigns the `rrwebSnapshot` global (no module/AMD loader in the page), exposing `snapshot`,
 * `rebuild`, `createCache`, and `createMirror`.
 */
let cached: string | null = null;

export function rrwebRuntimeSource(): string {
  if (cached !== null) return cached;
  // The package's main export resolves directly to the UMD build; read it as text to inject.
  const require = createRequire(import.meta.url);
  const umdPath = require.resolve("rrweb-snapshot");
  cached = fs.readFileSync(umdPath, "utf8");
  return cached;
}

/** The browser global the UMD bundle installs, and the members we use off it. */
export const RRWEB_GLOBAL = "rrwebSnapshot";
