/**
 * Type-level regression guard (`*.test-d.ts` — typechecked by `tsc`, not run by vitest, never bundled
 * or published). It locks the two type facts about `reducedMotion` that are easy to get wrong:
 *
 *  1. `reducedMotion` is NOT a top-level Playwright `use`/`TestOptions` option — it is a
 *     `BrowserContextOptions` field. So the valid way to emulate it in a config is
 *     `use: { contextOptions: { reducedMotion } }`, which is what the `playwright-visual-testing` skill
 *     points at. (This is Playwright's own design, not something our SDK removes — vanilla
 *     `@playwright/test` rejects a top-level `use: { reducedMotion }` identically.)
 *  2. Swapping `@playwright/test` for `@uiverify/playwright` does NOT strip standard `use` options: our
 *     `test` still accepts `colorScheme`, `userAgent`, `contextOptions`, etc. We override the `userAgent`
 *     option to append the capture marker (see ./fixture); these checks prove that override keeps the
 *     option's public type intact rather than replacing the interface.
 *
 * If a future change narrowed our option surface, one of these assignments would stop compiling and
 * `pnpm typecheck` would fail.
 */
import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { test } from "./fixture";

// The valid reduced-motion form, alongside other standard `use` options, in a config typed against
// Playwright's own `PlaywrightTestConfig`.
const config: PlaywrightTestConfig = defineConfig({
  use: {
    contextOptions: { reducedMotion: "reduce" },
    colorScheme: "dark",
    userAgent: "custom-agent",
  },
});
void config;

// Standard options remain settable through the SDK's `test` — `extend` (and our `userAgent` override)
// did not drop them.
test.use({ colorScheme: "dark" });
test.use({ userAgent: "still-settable" });
test.use({ contextOptions: { reducedMotion: "reduce" } });
