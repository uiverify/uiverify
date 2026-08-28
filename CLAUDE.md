# CLAUDE.md — `uiverify` (public client packages)

A pnpm **monorepo** of the public, client-installed packages for **UI Verify** (visual testing),
published as standalone open-source packages that talk to the UI Verify service **only over HTTP / MCP**:

- **`packages/cli`** (`uiverify`) — the CI uploader (`uiverify upload`).
- **`packages/playwright`** (`@uiverify/playwright`) — the Playwright capture SDK (swap `@playwright/test`
  for it; each test archives its final UI state for UI Verify to replay + diff). It writes an archive dir the CLI
  uploads; its archive-format types are a **local mirror** of the UI Verify service's wire contract, kept in
  sync by hand. Build: `tsup` → ESM + d.ts.
- **`packages/skills`** (`@uiverify/skills`, `private`) — agent skills: plain `SKILL.md` workflows a coding
  agent runs in the user's repo to set up visual testing, author economical + deterministic stories, and triage
  builds. Markdown only, no runtime code or build step; talks to UI Verify over HTTP / MCP. **Not published to
  npm** — distributed as a Claude Code plugin (this repo doubles as a plugin marketplace,
  `.claude-plugin/marketplace.json`; the plugin manifest is `packages/skills/.claude-plugin/plugin.json`).

**The invariants below are written for the CLI, but the cross-cutting rule — dumb client, no server-side
product logic, publishable & safe to open-source — applies to EVERY package here.** The CLI's "never fail the
consumer's CI" exit-code rule is CLI-specific.

## Hard invariant — keep this client dumb

The CLI talks to the UI Verify service **only over HTTP**. It must NOT gain a dependency on
server-side code or service internals:

- **No rendering / diffing / judging logic.** That all runs server-side. The client only builds a
  Storybook bundle, uploads it, registers the build, and reads back status.
- **Wire contracts are defined locally** (`src/client.ts`) — request/response shapes mirror the
  UI Verify ingest API. If the API changes, update them here by hand; do not import them from
  elsewhere.
- **Publishable & safe to open-source.** It's bundled to a single `dist/uiverify.js` (esbuild inlines
  `tar` + `zod`), so the published artifact carries no external runtime deps.

If you ever need a helper, write it here or pull a public npm package — never reach back into
server-side code.

## Hard invariant — the public surface is a contract; ASK before widening it

Every flag, env var, exported symbol and skill name in this repo is **published under a version
consumers pin** (`npx uiverify@<ver> upload …`) and mirrored to a public repo. Adding one is cheap in
the moment and permanent afterwards — removing it later is a breaking change for someone else's CI.

So implement **exactly the surface that was asked for, and nothing adjacent**. Confirm with the
maintainer before adding any more of it, and especially before adding a **second way to express the
same thing**: one option, one spelling. No env-var "equivalent" for a flag, no `--no-x` twin, no alias
or shorthand, unless the ask named it.

The failure this exists to stop is not one bad flag, it's the **accretion**, where every step looks
locally reasonable: `--only-changed` was specified → an unasked-for `UIVERIFY_ONLY_CHANGED` was added
as a "convenience" → review then noticed a job-wide env had no per-step escape → `--no-only-changed`
was added to serve it. Three ways to set one boolean, two of them contradictory, for an option whose
whole job is "render less this run". **When a review finding says an input needs an escape hatch, the
first question is whether that input should exist at all** — deleting the env var deleted the negative
flag and the entire precedence module with it.

This is a judgment call, so no lint can check it. The guard is asking first.

## Hard invariant — every operational failure funnels through `softFail()`

`uiverify upload` has three non-zero exits. Two are about the *run*; the third is about the *invocation*,
and the distinction is what keeps `--no-strict` honest:

- **Operational failures route through `softFail()`** in `bin/uiverify.ts` — the upload itself not
  happening: missing/invalid `UIVERIFY_API_KEY`, a missing/empty `--static-dir`, and any
  network/timeout/5xx that survives `withRetry`. `resolveStrict()` decides whether it exits **1** (strict)
  or logs `[uiverify] ⚠ …` and exits **0** (non-strict).
- **Strict-by-default (fail-closed):** an operational failure fails the job so a silently dropped upload
  can't leave CI green ("green but nothing was uploaded"). Precedence: an explicit `--strict`/`--no-strict`
  wins; else strict.
- **The visual verdict** (`changed`/`failed` → exit 1) on a normal run is the *other*, independent
  non-zero exit — the whole point of the default mode, gated by `exitCodeFor()` regardless of strict.
- **A malformed invocation exits 2 unconditionally**, NOT through `softFail()`: an unknown or misspelled
  option, a boolean given a value, a stray token (`parseArgs`' `invalid`), or a bad subcommand.
  `--no-strict` says "don't fail my job if the upload breaks", which is not consent to skip the upload
  entirely — honouring it here would exit 0 having uploaded nothing, the exact outcome the funnel exists
  to prevent. The pre-allowlist parser silently ignored unknown flags and uploaded anyway, so swallowing
  this would be strictly worse than what it replaced.

When adding a new **operational** failure path, route it through `softFail()` — do not `throw` past
`main()`'s catch or call `process.exit(1)` directly. When adding a new **argv-validation** path, add it to
`parseArgs`' `invalid` so it joins the exit-2 funnel. The API key is redacted from every message.

## The capture-determinism skills share a core — a universal learning lands in all three

`storybook-visual-testing`, `vitest-visual-testing`, and `playwright-visual-testing` teach the same job —
stop flaky visual diffs — to three capture surfaces, so most of what they say is **universal** and must
stay identical across them: the `isUIVerify()` escape hatch (charts, `<canvas>` / `requestAnimationFrame`
loops), freezing the clock, non-`Math.random` randomness (`crypto`/`uuid`/faker), honoring
`prefers-reduced-motion`, and above all **freezing live data with fixtures** — the single highest-value,
*headline* determinism step wherever a component renders in isolation (Vitest and Storybook; the same
lever is recipe 2/6 on a real page).

So when you add or change a **universal** lever in one skill, **port it to the other two in the same
change**, and mark which parts are universal vs **surface-specific**. What is deliberately NOT shared:
SSR-time `Math.random()` + `UI_VERIFY=1` on the app server, and the global-RNG-consumed-by-render-order
→ local-seed fix, are **real-app / Playwright only** (Vitest and Storybook have no SSR, and the capturer
seeds `Math.random` before app code); scroll-settling, flag/third-party stubbing, and loading-skeleton
waits are **real-page only**. The failure this prevents is silent and already happened once: a real-app
determinism port improved the Playwright skill's coverage of a shared concept (the `<canvas>` fix, the
data-mocking headline) and left the siblings behind, so an agent reading the Storybook skill would never
learn it. No lint can diff prose against prose — the guard is porting the learning while it is in your
hands. (Also note the parity of the record-time markers: the Playwright SDK sets **both** the UA marker
and the `window` global, but the Vitest SDK's browser provider owns the context, so it sets only the
global — `isUIVerify()` still matches via the `or`, but don't claim the UA branch works for Vitest.)

The **same subjects are also taught on the public product docs** (`uiverify.ai/docs`, maintained in the
service repo — *not* here): a universal determinism change owes those articles a matching pass too.

## Build / test

- `pnpm build` — esbuild bundle → `dist/uiverify.js` (gitignored). `prepublishOnly` runs it.
- `pnpm test` — Vitest. `pnpm typecheck` — `tsc --noEmit`.

## `examples/` pin published versions — bump them with every release

The standalone example projects under `examples/` (`storybook`, `vitest`, `playwright`, `react-native`)
are meant to be **copied out and run against the published npm packages**, so their `package.json`s pin
the **published** versions (`uiverify`, `@uiverify/playwright`, `@uiverify/vitest`) — NOT `workspace:*`.
That means they don't move when you bump a package here: **whenever you publish a new version of any
client package, bump the matching `^x.y.z` in every `examples/*/package.json` that depends on it** in the
same change, or the examples silently install a stale SDK. `grep -rl '@uiverify/\|"uiverify"' examples/*/package.json`
finds them; the current published versions are what `npm view <pkg> version` reports.
