import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeInstallDir, installFiles, warmChrome } from "./warm";

// Real, so paths compare equal to the ones found past symlinks (macOS keeps tmp under /private).
const root = realpathSync(mkdtempSync(join(tmpdir(), "uiverify-warm-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A Chrome install as Linux packages lay it out: the executable, its .pak resources and a locales folder,
 *  reached through a symlink elsewhere on PATH. */
function install(name: string): { dir: string; link: string } {
  const dir = join(root, name, "opt", "chrome");
  mkdirSync(join(dir, "locales"), { recursive: true });
  writeFileSync(join(dir, "chrome"), Buffer.alloc(3000));
  writeFileSync(join(dir, "resources.pak"), Buffer.alloc(2000));
  writeFileSync(join(dir, "locales", "en-US.pak"), Buffer.alloc(1000));
  mkdirSync(join(root, name, "bin"));
  const link = join(root, name, "bin", "google-chrome");
  symlinkSync(join(dir, "chrome"), link);
  return { dir, link };
}

test("the install folder is the real executable's, found past a symlink", () => {
  const { dir, link } = install("linked");
  expect(chromeInstallDir(link)).toBe(dir);
});

test("a folder without Chrome's resources isn't an install: a wrapper script's /usr/bin is never read", () => {
  const bin = join(root, "wrapper", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "chromium"), "#!/bin/sh\nexec /usr/lib/chromium/chromium \"$@\"\n");
  expect(chromeInstallDir(join(bin, "chromium"))).toBeUndefined();
  expect(chromeInstallDir(join(root, "missing", "chrome"))).toBeUndefined();
});

test("every file is read, largest first, subfolders included", async () => {
  const { dir } = install("files");
  expect(await installFiles(dir)).toEqual([join(dir, "chrome"), join(dir, "resources.pak"), join(dir, "locales", "en-US.pak")]);
});

test("a folder larger than the cap is left alone", async () => {
  const { dir } = install("large");
  expect(await installFiles(dir, 5000)).toEqual([]);
});

test("warming reads the whole install, and nothing when there is no Chrome", async () => {
  const { link } = install("warm");
  expect(await warmChrome(link).done).toBe(6000);
  expect(await warmChrome(undefined).done).toBe(0);
  expect(await warmChrome(join(root, "missing")).done).toBe(0);
});

test("stopped, it reads nothing more", async () => {
  const { link } = install("stop");
  const warming = warmChrome(link);
  warming.stop();
  expect(await warming.done).toBe(0);
});
