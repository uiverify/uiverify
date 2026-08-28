import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

/**
 * Collect the screenshots Maestro just took into ./screenshots/ (where `uiverify upload --screenshots`
 * expects them), trimming the bottom device-chrome band as we go.
 *
 * Two reasons this step exists:
 * 1. Maestro writes `takeScreenshot` output under its own run artifacts (~/.maestro/tests/<ts>/…), not
 *    the working directory, so we copy the latest run's shots out.
 * 2. A full-screen capture includes the OS home indicator / gesture bar, whose brightness isn't
 *    deterministic (it dims a moment after launch). Trimming the bottom band leaves only the app's own
 *    pixels, so a screen that didn't change is byte-identical run to run.
 */

const NAMES = ["storefront", "product", "cart"];
const CHROME_FRACTION = 0.05; // fraction of height to trim off the bottom (home indicator / nav bar)

const testsDir = join(homedir(), ".maestro", "tests");
const latest = readdirSync(testsDir).sort().at(-1);
if (!latest) throw new Error(`no Maestro runs found in ${testsDir} — run \`maestro test\` first`);
const srcDir = join(testsDir, latest, "flow", "takeScreenshot", "screenshots");

const outDir = join(process.cwd(), "screenshots");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of NAMES) {
  const img = PNG.sync.read(readFileSync(join(srcDir, `${name}.png`)));
  const keptHeight = Math.round(img.height * (1 - CHROME_FRACTION));
  const out = new PNG({ width: img.width, height: keptHeight });
  img.data.copy(out.data, 0, 0, img.width * keptHeight * 4);
  writeFileSync(join(outDir, `${name}.png`), PNG.sync.write(out));
}

console.log(`Collected ${NAMES.length} screenshots -> screenshots/ (bottom ${CHROME_FRACTION * 100}% chrome trimmed)`);
