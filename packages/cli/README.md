<div align="center">

<a href="https://uiverify.ai">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://uiverify.ai/brand/logo-mark-dark.png" />
    <img src="https://uiverify.ai/brand/logo-mark-light.png" alt="UI Verify" width="96" height="96" />
  </picture>
</a>

# UI Verify

### Visual testing for agents

Catch unintended UI changes on every pull request. UI Verify renders your components in the cloud, diffs them against a baseline, and lets a coding agent triage what actually changed.

[![uiverify](https://img.shields.io/npm/v/uiverify?label=uiverify&color=2ea44f)](https://www.npmjs.com/package/uiverify)
[![@uiverify/playwright](https://img.shields.io/npm/v/@uiverify/playwright?label=%40uiverify%2Fplaywright&color=2ea44f)](https://www.npmjs.com/package/@uiverify/playwright)
[![@uiverify/vitest](https://img.shields.io/npm/v/@uiverify/vitest?label=%40uiverify%2Fvitest&color=2ea44f)](https://www.npmjs.com/package/@uiverify/vitest)
[![@uiverify/bun](https://img.shields.io/npm/v/@uiverify/bun?label=%40uiverify%2Fbun&color=2ea44f)](https://www.npmjs.com/package/@uiverify/bun)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/uiverify/uiverify/blob/main/LICENSE)

[uiverify.ai](https://uiverify.ai) &nbsp;·&nbsp; [GitHub](https://github.com/uiverify/uiverify) &nbsp;·&nbsp; [CLI](https://www.npmjs.com/package/uiverify) &nbsp;·&nbsp; [Playwright SDK](https://www.npmjs.com/package/@uiverify/playwright) &nbsp;·&nbsp; [Vitest SDK](https://www.npmjs.com/package/@uiverify/vitest) &nbsp;·&nbsp; [Bun SDK](https://www.npmjs.com/package/@uiverify/bun) &nbsp;·&nbsp; [Skills](https://github.com/uiverify/uiverify/tree/main/packages/skills)

</div>

---

# uiverify

The CI uploader for UI Verify. `uiverify upload` uploads your prebuilt Storybook bundle (or a Playwright/Vitest/Bun archive, or a directory of finished screenshots), streams render progress (`Rendered X / N`), and reflects the visual verdict (`changed` / `failed`) in its exit code so CI can gate on it.

## Usage

Build your Storybook first, then point `--static-dir` at its output:

```sh
npm run build-storybook -- --stats-json
UIVERIFY_API_KEY=... npx uiverify upload --static-dir storybook-static
```

`--stats-json` writes Storybook's dependency graph, which lets UI Verify skip the stories your change can't affect (see [Skipping unchanged stories](#skipping-unchanged-stories)).

Or upload finished screenshots your own harness already produced (native, mobile, React Native, anything) with `--screenshots`. No Storybook and no server-side rendering: UI Verify diffs, judges, and baselines the PNGs directly.

```sh
UIVERIFY_API_KEY=... npx uiverify upload --screenshots ./screenshots
```

Each image is keyed by its path under the directory with the extension dropped, so a screen maps to the same baseline every build. Upload only the screens you changed and the rest carry forward (the client is the source of truth for what changed, the same trade-off TurboSnap and Argos make).

## Signing in instead of a key

On your own machine, sign in once and `upload` and `check` need no key:

```sh
npx uiverify login
npx uiverify upload --static-dir storybook-static
```

`login` prints a link and a short code and opens the link in your browser when it can. Sign in (or sign up) there and approve; the CLI receives the login. UI Verify picks the project from your repository (the `origin` remote, and `upstream` for a fork) and what you upload. When you have none yet, the first upload creates it, and your first team (named after the repository's owner), and prints what it created with a link to it. When that is ambiguous, the upload asks instead: which team, when you're in several (pass `--project <team>/<name>`), or whether a project that could be this one is it (pass `--project <team>/<slug>` to use it, or the `--project … --confirm-new <code>` it prints to create a new one).

- **In a coding agent's shell** (no terminal), `login` waits at most a minute, or not at all when it couldn't open a browser, and exits 1 saying what to do. The agent shows the link and code to you, then runs `npx uiverify login` again right away, and again while it says it is still waiting: a code lasts about 5 minutes, and a rerun keeps the same code and finishes a sign-in you already approved. It exits 0 only once you are signed in, so `npx uiverify login && npx uiverify upload ...` never uploads without a login.
- **Where it is stored**: one file per machine, `~/.config/uiverify/credentials.json` (`$XDG_CONFIG_HOME`, or `%APPDATA%\uiverify` on Windows), readable only by you, never in your repository. Where your system keeps keys for you, a `login` seals it with a key kept there, so the file at rest (a backup, a synced dotfiles folder) is unreadable on its own: the login keychain on macOS, Windows data protection (DPAPI) on Windows, and on a Linux desktop the keyring (GNOME Keyring, KWallet), which needs `secret-tool` (package `libsecret-tools` on Ubuntu and Debian). Programs running as you can still get that key, as they could read the file. Logins are kept per UI Verify server and renewed quietly.
  - Only a `login` into an empty store seals it, so after installing `secret-tool`, run `npx uiverify logout` (for every server you use) and `npx uiverify login` again.
  - On Linux the keyring is used only inside a graphical desktop login, not over SSH, in WSL, in a container, or in a session started from a text console (`startx`, `sway`). There, `upload` can't open a login sealed at the desktop, `login` moves it aside (rename it back to use it again) and stores a plain one that both then share, and `logout` deletes it. Windows usually behaves the same over SSH (signed in with a key rather than a password).
  - A keyring app that asks you to confirm each read (KeePassXC) asks on every `upload`; allow `uiverify` there for good, or use `UIVERIFY_API_KEY`. On Windows each command that reads the login starts Windows PowerShell once, which adds a moment.
  - A config folder synced between a Mac and a Linux or Windows machine keeps one plain login once the second machine signs in. Two Linux machines (or two Macs) sharing one config folder sign each other out: give each its own (`XDG_CONFIG_HOME`).
- `npx uiverify whoami` prints who you are signed in as; `npx uiverify logout` forgets the login. Which server they use comes from `UIVERIFY_API_URL`.
- In CI, keep using `UIVERIFY_API_KEY`. When it is set it always wins over a login.

## Options

- `--static-dir <dir>`: the prebuilt Storybook static directory to upload (e.g. `storybook-static`).
- `--screenshots <dir>`: a directory of finished PNG/JPG screenshots to upload directly (native / mobile / React Native), instead of `--static-dir`. Skips rendering entirely; images are keyed by their path under the directory.
- `--project <slug|team/slug>`: the project to upload to. Signed in, UI Verify otherwise picks it from your repository and what you upload, and a name that matches nothing creates that project (prefix the team when you're in several); with a key, it must name the key's own project.
- `--confirm-new <code>`: signed in, create the `--project` even though the upload asked whether an existing project is this one; the code is the one that question printed.
- `--working-directory <dir>`: the repo checkout (git metadata + the bundle live here).
- `--api-url <url>`: UI Verify API URL (default `https://uiverify.ai`; or `UIVERIFY_API_URL`).
- `--auto-accept-changes`: accept this build's changed snapshots as the new baseline (no review). Typically used on merges to your default branch.
- `--exit-zero-on-changes`: detect but don't block. A `changed` (needs-review) verdict exits 0 and stays pending review; `failed` still exits non-zero.
- `--render-all`: render every story, even ones the dependency graph shows your change can't reach, and even if this exact commit already passed.
- `--strict` / `--no-strict`: whether an operational failure (missing key or login, missing bundle, network error) fails the job. Strict by default.

Exit codes: `0` success (or an operational failure under `--no-strict`), `1` the visual verdict or an operational failure under strict, `2` a malformed invocation (unknown option, boolean given a value, or stray token). Exit 2 ignores `--no-strict` - that flag means "don't fail my job if the upload breaks", not "run with arguments I didn't mean".

## Skipping unchanged stories

When the bundle carries a dependency graph (`preview-stats.json` at the root of the upload directory; for a Vitest archive, one written by `@uiverify/vitest` 1.6.0 or later), UI Verify renders just the stories your change could have affected and carries every other baseline forward at a fraction of a snapshot each, so a one-component PR costs far less than a full suite. This is the default; there is nothing to turn on. The CLI works out which files changed with `git diff` in your checkout and sends only the paths.

Where the graph comes from:

- **Storybook**: build with `--stats-json` (Storybook 8+; `--webpack-stats-json` on 7.x).

  ```sh
  npm run build-storybook -- --stats-json
  UIVERIFY_API_KEY=... npx uiverify upload --static-dir storybook-static
  ```

- **Vitest**: `@uiverify/vitest` 1.6.0 and later writes the graph into the archive itself (keep `uiverifyPlugin()` in your root Vitest config). Tests whose imports git can't follow, such as bundler output or gitignored generated code, are left out of the graph and always render; the test run says how many and why.
- **Playwright or another archive**: add a `preview-stats.json` to the archive directory yourself, in the [module graph format](https://uiverify.ai/docs/skip-unchanged#module-graph-format).

Without a graph there is no fallback: every story renders, deliberately, since a filename heuristic can't tell that a page story imports the component you changed. For Storybook and Vitest the upload log says so on every run (unless you passed `--render-all`) and names the way to get a graph. Screenshot uploads never skip server-side; upload only the screens you changed instead.

Uploading from a checkout with uncommitted edits is safe. The CLI counts files that differ from the commit as changed (outside CI, untracked files that aren't ignored too), so what they affect renders. Such a build can still be reviewed and accepted, but later builds don't skip stories based on it.

To render everything for one build, pass `--render-all`.

## Environment

- `UIVERIFY_API_KEY`: your project key. Required in CI; on your own machine `npx uiverify login` instead. When set, it wins over a login. Only ever sent in the `Authorization` header, and redacted from all logs.
- `UIVERIFY_API_URL`: override the default API URL (self-host / local dev).
- `UIVERIFY_TELEMETRY`: set to `0` to turn off failure reports, for runs and logins (below).

## Failure reports

When `upload` or `check` fails before its build reaches UI Verify (a missing key, nothing captured, a rejected
upload, a network error), the CLI sends UI Verify one short report so a broken setup can be spotted and fixed:

- the command (`upload` or `check`) and the step it failed at (arguments, auth, git, capture, archive, register,
  upload),
- an error class (such as `missing_dir` or `http_401`) and the error message, with keys masked and every path
  outside your repository removed; for an HTTP error only the status and UI Verify's own error text, never
  another server's response (signed in, only the status),
- the CLI version, the capture SDK and its version, the framework and how it was found (from the capture
  output, or from a `package.json` naming exactly one framework), the OS, CPU architecture and Node version,
  and whether it ran in CI,
- which kind of credential the run used (a key, a login, or none),
- signed in with `uiverify login`: your login (to say whose setup failed), the repository's name and its
  `upstream`'s, and `--project` (or the project the build was registered to), used only to find the project
  and never recorded.

When `uiverify login` ends without signing you in (the sign-in server wouldn't create a code, the sign-in was
denied, the code expired or was already used, the account never finished being set up, or the approved login was
refused), it sends one report for that attempt:
how it ended, the CLI version, the OS, CPU architecture and Node version, and whether it ran in CI or in a
terminal. It has no free text. A login still waiting for you to approve sends nothing about its own code; a rerun that finds the previous
code expired unused reports that one. Its requests to
UI Verify also carry the CLI version and whether it runs in CI or a terminal.

It never sends code, file contents or environment values, except the repository's name when signed in (which can
come from your CI's environment). The report goes from a background process, so the command's exit code never
depends on it and nothing waits for it to arrive, and the CLI prints a line when it sends one. Signed in, a run
may renew its login once when it starts, so the report can say who sent it, and the report reads the repository's
remote names from git first (a few milliseconds, at most 2 seconds if git hangs). Set `UIVERIFY_TELEMETRY=0` to turn all of it off.

## License

MIT
