import { spawn } from "node:child_process";

/** The OS command that opens a URL in the default browser. */
export function browserOpener(url: string, platform: NodeJS.Platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/**
 * Best effort: the link is already printed, so a machine with no browser (or no opener) loses nothing.
 * Resolves whether a browser plausibly opened: the opener exited 0, or is still running after a second. A
 * missing opener, or one that fails (`xdg-open` with no handler), counts as "no browser". The timer is
 * deliberately not unref'd: it is what keeps this process alive until the opener answers, since the opener
 * itself is detached and unref'd.
 */
export function openBrowser(url: string, opener: [string, string[]] = browserOpener(url, process.platform)): Promise<boolean> {
  // The link comes from the server's answer; only a web page is handed to the OS opener, never a file or app.
  if (!/^https:\/\//i.test(url)) return Promise.resolve(false);
  const [cmd, args] = opener;
  return new Promise((resolve) => {
    let stillRunning: NodeJS.Timeout | undefined;
    const done = (opened: boolean): void => {
      clearTimeout(stillRunning);
      resolve(opened);
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      stillRunning = setTimeout(() => done(true), 1_000);
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
      child.unref();
    } catch {
      done(false);
    }
  });
}
