import { existsSync, realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Past this, a folder isn't a Chrome install: reading it would cost more than the start it saves. */
const MAX_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const READERS = 4;

/** The folder Chrome's own files are in: the one holding the real executable (past the symlinks and the
 *  wrapper script next to it) and its `.pak` resources. Nothing for anything else, such as a wrapper script in
 *  `/usr/bin` or the macOS app's `Contents/MacOS`. */
export function chromeInstallDir(chrome: string): string | undefined {
  let dir: string;
  try {
    dir = dirname(realpathSync(chrome));
  } catch {
    return undefined;
  }
  return existsSync(join(dir, "resources.pak")) ? dir : undefined;
}

/** Every file under `dir`, largest first, or none if they add up to more than `maxBytes`. */
export async function installFiles(dir: string, maxBytes = MAX_BYTES): Promise<string[]> {
  const files: { path: string; size: number }[] = [];
  let total = 0;
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (total > maxBytes) return;
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const { size } = await stat(path);
        total += size;
        files.push({ path, size });
      }
    }
  };
  try {
    await walk(dir);
  } catch {
    return [];
  }
  return total > maxBytes ? [] : files.sort((a, b) => b.size - a.size).map((file) => file.path);
}

/**
 * Read Chrome's files into the OS page cache, so each shard's first Chrome start finds them in memory. On a
 * fresh CI VM they are on a cold disk, and Chrome's own scattered reads of them have taken over a minute where
 * reading them in order takes seconds (igrlk/visual-testing#1282). Best effort: any error ends it quietly,
 * and `stop()` ends it between reads. `done` resolves to the bytes read.
 */
export function warmChrome(chrome: string | undefined): { done: Promise<number>; stop(): void } {
  let stopped = false;
  let bytes = 0;
  const done = (async () => {
    // Off the caller's turn: even finding the files reads a cold disk.
    await Bun.sleep(0);
    const dir = chrome && chromeInstallDir(chrome);
    if (!dir) return 0;
    const queue = await installFiles(dir);
    const reader = async () => {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      for (let path = queue.shift(); path && !stopped; path = queue.shift()) {
        const file = await open(path, "r").catch(() => undefined);
        if (!file) continue;
        try {
          for (;;) {
            const { bytesRead } = stopped ? { bytesRead: 0 } : await file.read(buffer, 0, CHUNK_BYTES, null);
            if (!bytesRead) break;
            bytes += bytesRead;
          }
        } catch {
          // Unreadable: Chrome will read it itself.
        } finally {
          await file.close().catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: READERS }, reader));
    return bytes;
  })().catch(() => bytes);
  return {
    done,
    stop: () => {
      stopped = true;
    },
  };
}
