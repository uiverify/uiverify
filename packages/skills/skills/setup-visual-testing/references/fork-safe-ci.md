# Fork-safe CI: the two-workflow setup

For a **public repo** (or any repo that takes pull requests from forks). GitHub never passes repository
secrets to a `pull_request` run from a fork, so the one-job workflow in Step 4 captures fine on a fork PR
but has no `UIVERIFY_API_KEY` to upload with, and the UI Verify check never posts. The fix is two
workflows:

1. **`visual.yml`** captures on every `pull_request` and `push`. For a push or a PR from the repo's own
   branches it uploads in the same job, with the key. For a fork's PR it saves the capture as an artifact.
2. **`visual-upload.yml`** runs on `workflow_run` after `visual.yml` succeeds on a fork's PR, downloads the
   artifact, and uploads it for the PR's commit, branch and number. GitHub always runs it from the default
   branch's copy, with secrets, so a PR cannot change what it does. It never runs code from the PR.

The full walkthrough, and why not `pull_request_target`: https://uiverify.ai/docs/open-source-and-forks

## `.github/workflows/visual.yml`

Same capture steps as Step 4 (Storybook shown; swap in the Playwright / Vitest / Bun capture, which writes
`./uiverify-archive`). For the screenshot-upload path, save `./screenshots` as the artifact and use
`--screenshots` instead of `--static-dir` in both uploads. Keep the two `if:` conditions exactly as written: they are opposites, so every run
either uploads or saves the artifact. Change `[main]` to the repo's default branch.

```yaml
name: Visual tests
on:
  push:
    branches: [main]                           # your default branch
  pull_request:

jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run build-storybook -- --stats-json    # writes ./storybook-static

      # Everything except a fork's pull request: upload here, with the key.
      - name: Upload to UI Verify
        if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
        run: |
          FLAGS="--static-dir ./storybook-static"   # ./uiverify-archive for Playwright / Vitest / Bun
          if [ "$GITHUB_EVENT_NAME" = "push" ]; then FLAGS="$FLAGS --auto-accept-changes"; fi
          npx uiverify upload $FLAGS
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}

      # A fork's pull request has no key: save the capture for visual-upload.yml.
      - name: Save the capture
        if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository
        uses: actions/upload-artifact@v4
        with:
          name: uiverify-archive                 # visual-upload.yml downloads it by this name
          path: ./storybook-static/              # ./uiverify-archive/ for Playwright / Vitest / Bun
          include-hidden-files: true             # keep capture files whose names start with a dot
          if-no-files-found: error
          retention-days: 7
```

## `.github/workflows/visual-upload.yml`

Add it as is, with two edits: `workflows:` must match the `name:` of `visual.yml`, and replace
`<version>` with the exact `uiverify` version the repo installed in Step 2 (read it from the lockfile).
The pin matters: this job holds the key, so it must run a fixed CLI from an empty directory, never
`npx` inside the PR's tree, where an edited `.npmrc` or `package.json` could swap the CLI.

```yaml
name: Visual upload

# Runs from the default branch with secrets, after "Visual tests" finishes on a fork's
# pull request. Never runs code from the pull request: no checkout of its files, no
# npm ci, no npx inside its tree. Branch names reach the shell only through env.
on:
  workflow_run:
    workflows: [Visual tests]
    types: [completed]

permissions:
  contents: read
  actions: read
  pull-requests: read

jobs:
  upload:
    if: >
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.head_repository.full_name != github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 24

      - uses: actions/download-artifact@v4
        with:
          name: uiverify-archive
          path: ${{ runner.temp }}/archive
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}

      - name: Find the pull request
        id: meta
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}
          HEAD_OWNER: ${{ github.event.workflow_run.head_repository.owner.login }}
        run: |
          set -euo pipefail
          # workflow_run lists no pull requests for a fork, so look it up by its head.
          # -f encodes the branch name, which may contain characters like "&".
          pr=$(gh api -X GET "repos/$REPO/pulls" -f state=open -f "head=$HEAD_OWNER:$HEAD_BRANCH" --jq '.[0].number // empty')
          if [ -z "$pr" ]; then echo "::warning::No open pull request for $HEAD_OWNER:$HEAD_BRANCH, so nothing was uploaded."; fi
          {
            echo "pr=$pr"
            echo "branch<<__EOF__"
            echo "$HEAD_OWNER:$HEAD_BRANCH" # a fork's "main" must not look like yours
            echo "__EOF__"
          } >> "$GITHUB_OUTPUT"

      - name: Fetch the commit's history (objects only, no checkout)
        if: steps.meta.outputs.pr != ''
        env:
          REPO: ${{ github.repository }}
          HEAD_SHA: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          git init -q "$RUNNER_TEMP/repo"
          cd "$RUNNER_TEMP/repo"
          git remote add origin "https://github.com/$REPO"
          git fetch -q --filter=blob:none --no-tags origin "$HEAD_SHA"
          git update-ref HEAD "$HEAD_SHA"

      - name: Upload to UI Verify
        if: steps.meta.outputs.pr != ''
        env:
          UIVERIFY_API_KEY: ${{ secrets.UIVERIFY_API_KEY }}
          COMMIT_SHA: ${{ github.event.workflow_run.head_sha }}
          BRANCH: ${{ steps.meta.outputs.branch }}
          PR_NUMBER: ${{ steps.meta.outputs.pr }}
        run: |
          set -euo pipefail
          mkdir -p "$RUNNER_TEMP/clean" && cd "$RUNNER_TEMP/clean"
          npx -y uiverify@<version> upload \
            --static-dir "$RUNNER_TEMP/archive" \
            --working-directory "$RUNNER_TEMP/repo" \
            --exit-zero-on-changes
```

## Tell the user these, they can't be done from the repo

- `visual-upload.yml` only runs from the default branch, so fork PRs get the check **once it is merged**.
  The PR that adds it cannot exercise it.
- The gate on a fork PR is the `UI Verify: <slug>` commit status (the `workflow_run` job is recorded
  against the default branch and passes `--exit-zero-on-changes`). Make that status a required check.
- Dependabot PRs come from the repo's own branches but only get Dependabot secrets: add the same
  `UIVERIFY_API_KEY` under Settings → Secrets and variables → Dependabot.
- Keep GitHub's "Require approval for workflows from outside collaborators" on (Settings → Actions).
- Contributors open the diff from the PR comment only if the UI Verify project is **Public**. The first
  project created with the open-source option in onboarding starts public; for any other, a team owner
  sets it under project settings → Visibility.
