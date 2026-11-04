import fs from "node:fs";

let cached: string | undefined;

/** The built page script (`src/page/main.ts`), read from next to this bundle in `dist/`. */
export function pageScriptSource(): string {
  cached ??= fs.readFileSync(new URL("./page-script.js", import.meta.url), "utf8");
  return cached;
}
