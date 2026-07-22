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

## Hard invariant — every operational failure funnels through `softFail()`

`uiverify upload` has two independent non-zero exits; every *operational* failure (the upload itself not
happening) routes through one funnel so the policy lives in one place:

- The whole operational flow funnels through `softFail()` in `bin/uiverify.ts`: missing/invalid
  `UIVERIFY_API_KEY`, a missing/empty `--static-dir`, a bad invocation, and any network/timeout/5xx that
  survives `withRetry`. `resolveStrict()` decides whether it exits **1** (strict) or logs `[uiverify] ⚠ …`
  and exits **0** (non-strict).
- **Strict-by-default (fail-closed):** an operational failure fails the job so a silently dropped upload
  can't leave CI green ("green but nothing was uploaded"). Precedence: an explicit `--strict`/`--no-strict`
  wins; else strict.
- **The visual verdict** (`changed`/`failed` → exit 1) on a normal run is the *other*, independent
  non-zero exit — the whole point of the default mode, gated by `exitCodeFor()` regardless of strict.

When adding any new operational failure path, route it through `softFail()` — do not `throw` past
`main()`'s catch or call `process.exit(1)` directly. The API key is redacted from every message.

## Build / test

- `pnpm build` — esbuild bundle → `dist/uiverify.js` (gitignored). `prepublishOnly` runs it.
- `pnpm test` — Vitest. `pnpm typecheck` — `tsc --noEmit`.
