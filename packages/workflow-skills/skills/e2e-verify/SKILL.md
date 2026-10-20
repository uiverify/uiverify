---
name: e2e-verify
description: Start your dev stack on isolated ports, authenticate Playwright with the user's browser session, and test the current branch. Use when asked to "e2e verify", "playwright test", "test everything", "test my changes with playwright", or "test this branch".
argument-hint: (optional - exact app URL or app port if the stack is already running)
context: fork
model: sonnet
---

# E2E Verify Skill

Starts your dev stack, authenticates Playwright with the user's real browser session, and tests the current branch. Runs in a forked context (`context: fork`) to keep screenshots and DOM snapshots out of the main conversation.

The stack is your whole app end-to-end. Use your dev command - ideally one that isolates the HTTP port so several worktrees can run at once, while sharing the one DB + storage.

## Step 1: Start the dev stack and determine ports

There are exactly three cases:

**Case A: User provided an exact app URL** (e.g., `/e2e-verify http://localhost:3020`).
Use that exact URL for both authentication and Playwright navigation. If the URL includes `localhost`, keep using `localhost` - never swap it for `127.0.0.1`. Skip starting the stack.

**Case B: User provided a port number** (e.g., `/e2e-verify 3020`).
Use `http://localhost:<port>` as the app URL. Skip starting the stack - assume it's already running.

**Case C: User did NOT provide a URL or port.**
You MUST start the stack yourself. Do NOT probe random ports to see what's running - another worktree's stack could be on those ports.

```bash
<your dev command>
```

Run this in the background. The command brings up the shared DB + storage (it does NOT migrate - run your one-time setup/migrate command first if the schema is stale), then starts the app and prints a banner with the assigned port(s), e.g.:

```
  App:     http://localhost:3110
  DB:      shared
  Storage: shared
  Logs:    <your log dir>
```

Service output goes to per-service log files (not stdout), so the banner is the only stdout you need.

**Prerequisite:** the dev command may require credentials for the human dashboard session (your auth provider's keys) - only the human dashboard session needs them. If the command errors that credentials are missing, tell the user how to provide them, then stop. (Skip this prerequisite if your dev command needs no credentials.)

**Reading output efficiently (important for token usage):**

- To get the banner, read only the first ~30 lines of the background process output (`head -30`). Do NOT read the full output.
- To debug a service, `tail -50` its log file in the printed log dir. The log files are your app's per-service logs (e.g. one per backend/frontend/worker process).
- Start with `tail -50` and only increase if needed. NEVER `cat` or `Read` an entire log file.

Parse the exact app URL from the banner and keep using that exact URL for the rest of the task.

Wait up to 90 seconds for the app to be healthy - a listening TCP port is not enough; require a real HTTP response (a redirect to the login page is fine - it means the server is up):

```bash
# GET (not --head): some frameworks (e.g. Next's App Router) compile the route on
# first request and don't answer HEAD until then. --fail treats only 4xx/5xx as
# failure, so a redirect to the login page still counts as healthy.
curl --fail --silent --max-time 60 --retry 9 --retry-delay 10 --retry-connrefused <app-url>/ -o /dev/null
```

If the exact app URL never returns a healthy HTTP response, `tail -50` the app's log, fix the stack, and do not authenticate Playwright until it's healthy.

**Always tell the user which exact URL the app is running on**, e.g.:

> App is running on http://localhost:3100

## Step 2: Authenticate Playwright

The dashboard auths via your auth provider and stores the session token in a cookie. Cookies are not port-scoped, so a token captured at any `localhost` port works for whatever slot port the stack is on. The user must be logged in to the dashboard in their normal browser (Arc/Brave/Chrome/Dia/Edge). (Skip this whole step if your app has no auth.)

Use the **same** exact URL for extraction and navigation. Never mix `localhost` and `127.0.0.1` in the same run.

### 2a. Extract the session cookie (Bash)

```bash
<your cookie-extraction command> <exact-app-url>
```

This decrypts the session cookie from the user's browser and writes a cookies JSON file. If it hangs, a macOS Keychain dialog is waiting - ask the user to click "Allow" / "Always Allow". If it reports no cookie found, the user isn't logged in at that host - ask them to open the dashboard in their browser and sign in, then retry.

### 2b. Inject the cookie and navigate (browser_run_code)

Read the cookies JSON file, then call `mcp__playwright__browser_run_code`, inlining the `cookies` array directly into the code string (`browser_run_code` cannot read files from disk):

```javascript
async (page) => {
  const cookies = <CONTENTS_OF_cookies_ARRAY_FROM_JSON>;
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
  await page.goto('<EXACT_APP_URL>/dashboard', { waitUntil: 'commit' });
  await page.waitForTimeout(2500);
  return { url: page.url(), title: await page.title() };
}
```

### 2c. Confirm auth succeeded

- If the returned URL lands on your auth provider's or a sign-in page, auth failed.
- Re-run the extractor once for the same exact URL. The session token is often short-lived - if it's expired, ask the user to reload the dashboard in their browser (which refreshes it) and re-extract.
- If it still lands on sign-in, stop and tell the user which exact URL you used and where the browser landed.

## Step 3: Determine what to test

**If the user gave specific test instructions** (e.g., "test the review flow", "test that the diff viewer renders", "test creating a project"), follow those exactly. Do NOT analyze the git diff - go straight to what they asked.

**Only if the user gave no specific instructions** (e.g., "test everything", "test this branch"), analyze the branch changes:

```bash
git diff --name-only origin/<default-branch>...HEAD
```

Read the changed files to understand the feature/fix, then determine what to test. Map the changed files to the surfaces that exercise them - e.g. frontend/UI changes → the app's pages and API routes; backend/worker changes → the background behavior observable through the UI (a job's output, a status that flips); CLI/entry-point changes → the flow that triggers them.

## Step 4: Test with Playwright

Navigate to the relevant dashboard pages and exercise the change:

- For UI changes: navigate to affected pages, interact with components, verify behavior.
- For API / worker / backend changes: drive the UI flows that exercise them (e.g. open the page that shows a background job's output, take an action on a record and confirm it persisted) and verify the results.
- Take screenshots at key points to verify what you're seeing.
- Test both the happy path and obvious edge cases.

**All scratch artifacts (screenshots, DOM snapshots, console dumps, any `.md` notes) MUST be written under `.e2e-verify/` at the repo root** - it's gitignored. Never write these to the repo root or any source directory.

```bash
mkdir -p .e2e-verify
```

Use paths like `.e2e-verify/step1-build-list.png`. When calling Playwright's `browser_take_screenshot`, pass a `filename` under `.e2e-verify/`.

### Persist what you proved

Driving the change usually means writing a throwaway assertion - a `browser_evaluate` that reads back
computed geometry, a request payload, a bit of state - and that assertion is very often *exactly* the
regression test the change needs. It was precise enough to convince you the feature works, so it is
precise enough to stop the feature silently breaking later. Once it's scrolled out of the transcript
it protects nothing.

So before you tear the stack down: for each invariant you verified this way, check whether a spec in
`<your e2e spec directory>` already reaches that surface (`git ls-files <your e2e spec directory>`, then grep for
the page or component). **If one does, add the assertion to it** - usually a couple of lines, and it
then runs on every PR via your CI e2e check. If no spec comes close, say so in your report rather than
scaffolding a new suite mid-verification; a named gap is a decision for the user, a silent one isn't.

Judgment applies: persist the invariant the *change* is about (the thing that would make the feature
wrong if it broke), not every incidental value you happened to read.

## Step 5: Clean up

**After all testing is complete:**

1. **Remove the scratch directory** so the next run starts clean:

   ```bash
   rm -rf .e2e-verify
   ```

   Exception: if testing failed and the user may want to inspect artifacts, leave `.e2e-verify/` in place and tell the user where to look (it's gitignored either way).

2. **Kill the dev stack** - only if you started it (Case C). The dev command traps its signals and tears down both services + releases the slot:

   ```bash
   kill <dev-command-pid>
   ```

   If the user provided a URL or port (Case A or B), do NOT kill the stack - they manage it themselves.

## Important notes

- NEVER probe random ports to detect running stacks - use the user-provided URL/port, or start your own slot.
- Always carry forward the exact URL used for auth. Do not swap `localhost` for `127.0.0.1`, or vice versa.
- A listening TCP port is not enough - require a healthy HTTP response (a redirect to login counts) before authenticating Playwright.
- Always confirm Playwright auth succeeded before testing. Your auth provider's or a sign-in page means auth failed. The session token is short-lived - expiry is the usual cause; have the user reload the dashboard to refresh it.
- The shared DB + storage mean parallel slots share data - fine for ports, but two branches with conflicting migrations will collide on the one DB.
- If the user asks to test something specific, test THAT - don't substitute your own plan from the diff.
- Always clean up the dev stack when done (unless the user provided the port/URL).
