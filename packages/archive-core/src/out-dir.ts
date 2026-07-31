import path from "node:path";

/** Where archives are written: `./uiverify-archive` under the process cwd, overridable via
 *  `UIVERIFY_ARCHIVE_DIR` so CI can point every parallel worker/test at one shared bundle dir. Both
 *  capture SDKs resolve the same way, so their output lands in the same place the CLI uploads. */
export function resolveOutDir(): string {
  return process.env.UIVERIFY_ARCHIVE_DIR ?? path.resolve(process.cwd(), "uiverify-archive");
}
