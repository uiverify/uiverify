/**
 * Record-time RNG seeding.
 *
 * The archive is a static snapshot of what the page was at capture, so a `Math.random()` pick made while a
 * component renders is baked in: an unpinned random pick (a shuffled list, a randomly chosen image) would
 * differ run-to-run. Seed it here - once as the setup module loads, reset before each test - so
 * random-paced content renders identically, without the author reaching for `vi.spyOn(Math, "random")`.
 *
 * We seed a *sequence*, not a constant: a fixed return value collapses every shuffle and makes two
 * "random" values identical.
 *
 * This reaches every pick, because a Vitest browser test renders in the browser (no SSR) - the pick
 * happens after the seed is installed. A pick a framework makes during its own server render is already in
 * the HTML, and is pinned in the component with `isUIVerify()` instead.
 */
const INITIAL_SEED = 0x2545f4914f6cdd1d;
let seed = INITIAL_SEED;
let installed = false;

function seededRandom(): number {
  seed ^= seed << 13;
  seed ^= seed >> 7;
  seed ^= seed << 17;
  return ((seed >>> 0) % 1e9) / 1e9;
}

/** Replace `Math.random` with the seeded PRNG. Idempotent; called once as the setup module loads, before
 *  any test renders a component. */
export function installSeededRandom(): void {
  if (installed) return;
  installed = true;
  Math.random = seededRandom;
}

/** Reset the sequence to its fixed start so each test's randomness is independent of the order tests ran
 *  in. No-op if seeding was never installed. */
export function resetSeed(): void {
  if (installed) seed = INITIAL_SEED;
}
