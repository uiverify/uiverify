import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openBrowser } from "./browser";

/** Runs `openBrowser` in a fresh Node process with nothing else keeping it alive, as `uiverify login` does
 *  right after printing the code, and prints what it resolved to. */
function inFreshProcess(url: string, opener: [string, string[]]): string {
  const browser = path.resolve(__dirname, "browser.ts");
  const script = `import { openBrowser } from ${JSON.stringify(browser)};
const opened = await openBrowser(${JSON.stringify(url)}, ${JSON.stringify(opener)});
console.log("resolved:" + opened);`;
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
}

describe("openBrowser", () => {
  /** Would catch: an opener and timer both unref'd, so the process exits 0 before `login` ever polls. */
  it("keeps the process alive until the opener answers", () => {
    expect(inFreshProcess("https://auth.example/device", [process.execPath, ["-e", "setTimeout(() => {}, 200)"]])).toContain("resolved:true");
  }, 30_000);

  it("counts an opener that fails or can't start as no browser", async () => {
    expect(await openBrowser("https://auth.example/device", [process.execPath, ["-e", "process.exit(3)"]])).toBe(false);
    expect(await openBrowser("https://auth.example/device", ["/nonexistent/opener", []])).toBe(false);
  });

  it("hands nothing but an https link to the OS", async () => {
    expect(await openBrowser("file:///Applications/Calculator.app", [process.execPath, ["-e", ""]])).toBe(false);
  });
});
