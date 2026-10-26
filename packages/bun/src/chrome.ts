import { existsSync } from "node:fs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The Chrome to drive: `BUN_CHROME_PATH` (Bun's own override, which the SDK honours because it always passes
 *  a path), else the first Chrome or Chromium on PATH, else the macOS app. Never a Chrome already running. */
export function chromePath(env: Record<string, string | undefined> = process.env): string {
  const which = (command: string) => Bun.which(command, { PATH: env.PATH ?? "" });
  const found =
    env.BUN_CHROME_PATH ||
    which("google-chrome") ||
    which("google-chrome-stable") ||
    which("chromium") ||
    which("chromium-browser") ||
    (existsSync(MAC_CHROME) ? MAC_CHROME : undefined);
  if (!found) {
    throw new Error(
      "@uiverify/bun: no Chrome found. Install Google Chrome or Chromium, or set BUN_CHROME_PATH to its executable.",
    );
  }
  return found;
}
