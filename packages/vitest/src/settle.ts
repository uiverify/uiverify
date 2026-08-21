/**
 * Record-time settling: wait for fonts and images to finish loading before we serialize, so every visible
 * resource is actually in the archive. The archive is a static snapshot, so a font still loading at
 * capture is absent (it shows as a fallback glyph) and an image still loading is absent (it shows broken) -
 * both are pure run-to-run flakes an author would otherwise chase with a manual settle helper.
 *
 * Time-boxed with the REAL `setTimeout`, captured at module load before a test can install fake timers
 * (`vi.useFakeTimers()` for a frozen clock), so a hung resource can never stall a capture and the cap
 * still fires in wall-clock time.
 */
const SETTLE_TIMEOUT_MS = 3000;
const realSetTimeout: (fn: () => void, ms: number) => unknown =
  typeof setTimeout === "function" ? setTimeout.bind(globalThis) : () => 0;

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(() => resolve(), ms));
}

function cap(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work, timeout(SETTLE_TIMEOUT_MS)]);
}

/** Load every registered `@font-face` and wait for the font set to be ready. Exported so a test can call
 *  it BEFORE `render()` for a component that measures text width on mount - a mid-load font bakes a wrong
 *  metric (a 1px-shifted layout) that settling AFTER render can no longer undo. */
export async function preloadFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const loadAll = Promise.all(Array.from(document.fonts, (f) => f.load().catch(() => undefined)));
  await cap(loadAll.then(() => document.fonts.ready));
}

/** Wait for fonts and every not-yet-complete `<img>` to finish loading, then return. Called by `capture()`
 *  right before the DOM is serialized. */
export async function settle(): Promise<void> {
  if (typeof document === "undefined") return;
  await preloadFonts();
  const pending = Array.from(document.images).filter((img) => !img.complete);
  if (!pending.length) return;
  await cap(
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    ),
  );
}
