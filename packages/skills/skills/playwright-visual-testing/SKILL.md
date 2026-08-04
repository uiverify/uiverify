---
name: playwright-visual-testing
description: Make @uiverify/playwright (archive-replay) captures deterministic so real-page visual tests stop coming back "changed" without a real change (flaky diffs). Use when driving a real page — your app under test, a staging build, or live production — and the diff flakes. A symptom-to-lever checklist for the run-to-run variation you probably have - feature flags, live data, the clock, third-party widgets, and dynamic layouts. The lever is almost always "stop the variation at record time" — the archive bakes in whatever the page was.
---

# Deterministic Playwright captures (archive-replay)

## Mental model

`@uiverify/playwright` captures each test's **final DOM + every resource the page loaded** into an
archive; UI Verify re-renders and pixel-diffs that archive server-side. So:

> Whatever the page **was at the instant of capture** is baked into the archive forever. Your job is to
> drive the page to one canonical state before the snapshot. UI Verify can't un-see a random A/B variant,
> a live feed, or a piece of lazy content that never loaded.

The snapshot fires automatically when the test passes, so your `beforeEach` + navigation *is* the
determinism surface. Integration is one import:

```diff
- import { test, expect } from '@playwright/test';
+ import { test, expect } from '@uiverify/playwright';
```

**What UI Verify handles server-side (don't hand-fix these):** it re-renders the archived DOM with
animations disabled, `prefers-reduced-motion` emulated, and fonts and images settled. So pixel-level settling — waiting on `document.fonts.ready`, sticky-header animation, image
decode — is **not** your job. Your job is narrower: make sure the **content and state** the archive
records is the same every run.

## The core skill: recognize the class, then pull the lever at record time

Everything below is the same move — *something rendered differently run-to-run and it wasn't a real
change; find what injected the variation and pin it before the snapshot.*

| Symptom in the diff | Cause class | Lever |
|---|---|---|
| Whole page reflows; height differs between runs | **Feature flag / A-B experiment** rendering a different variant per load (Optimizely, LaunchDarkly, VWO, your own) | **Stub the flag calls** so one fixed variant renders → recipe 1 |
| A list / feed / counts differ | **Live data** from an API | **Mock the endpoint** with a fixed response → recipe 2 |
| Timestamps, "today", a year, a chart's day axis drift | **The clock** (`Date.now`) at render time | **Freeze `Date`** before navigation → recipe 3 |
| A banner / chat / consent overlay appears or shifts | **Third-party widget** injecting DOM | **Stub or dismiss** it → recipe 1 + 4 |
| Blank/placeholder where an image should be | **Lazy content** that never loaded, so its bytes aren't in the archive | **Trigger it at record time** → recipe 5 |
| Same content, packed or ordered differently each run | **Dynamic layout** that reflows or reorders on its own | **Mask** it (or pin a fixed order/size) → recipe 6 |
| An infinite JS animation the capturer can't stop (a charting lib's loop, a `<canvas>` spinner) | **App-driven animation** with no final frame | **Branch the component on capture** and render the end state → recipe 7 |

Prefer removing a whole class at the source: **test a build/staging with flags and third-party scripts
off** and rows 1 and 4 disappear before you write any code.

## Recipes

**1. Stub feature-flag / third-party scripts** (register in `beforeEach`, before `goto`):
```ts
await page.route(/optimizely|optly|launchdarkly|segment|intercom/i, (route) =>
  route.fulfill({ status: 204, body: '' }).catch(() => undefined),
);
```
Use `fulfill({ status: 204 })`, **not `route.abort()`** — an aborted request reads as pending network
activity and can hang the page's readiness wait. A 204 completes it empty: the script "loads," resolves
no variant, and the page renders its control DOM. Identify the culprit by loading the page a few times
and watching `document.body.scrollHeight` flip between values.

**2. Mock live data:** intercept the API route and `fulfill` a fixed JSON fixture — same shape every run.
```ts
await page.route('**/api/items', (route) =>
  route.fulfill({ json: fixtures.items }),
);
```

**3. Freeze the clock** (before navigation — it changes what the app renders into the DOM). Use
Playwright's built-in clock so `Date`, `Date.now()`, and `Date()`-without-`new` all stay correct:
```ts
await page.clock.setFixedTime(new Date('2020-01-01T00:00:00Z'));
```

**4. Dismiss overlays** (best-effort; absent = fine):
```ts
await page.getByRole('button', { name: 'Accept All' }).click({ timeout: 4000 }).catch(() => {});
```

**5. Trigger lazy content so its bytes land in the archive.** This is the one "settle" that *is* yours —
not for pixel-stability (UI Verify handles that) but because content that never loaded was never
recorded. Scroll it into view before the snapshot:
```ts
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += innerHeight) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  scrollTo(0, 0);
});
```

**6. Neutralize what can't be pinned** — there's no separate mask step; UI Verify diffs the
*archived DOM*, so hide the unstable element in the DOM before the snapshot and its varying
content never lands in the archive:
```ts
// target the container that reflows or reorders between runs
await page
  .locator('[data-testid="dynamic-region"]')
  .evaluateAll((els) => els.forEach((el) => (el.style.visibility = "hidden")));
```

**7. Freeze an app-driven JS animation** the capturer can't reach — an infinite charting-library loop, a `<canvas>` spinner with no final frame. Detect the capture *in the component* and render the end state. `@uiverify/playwright` sets a `UIVerify` user-agent marker and a `window.__UI_VERIFY__` global at record time, so a client-side branch works on its own; if the component decides this during **server-side rendering** (no `window` yet), also set a `UI_VERIFY` env var when you boot the app for the record run and check it:
```ts
// in the component (your app code, not the test):
const isUIVerify = () =>
  (typeof process !== 'undefined' && !!process.env.UI_VERIFY) ||            // SSR / build time
  (typeof window !== 'undefined' &&
    (navigator.userAgent.includes('UIVerify') || '__UI_VERIFY__' in window)); // browser

<Chart isAnimationActive={!isUIVerify()} />
```
Boot the app with the env var for the capture run only — e.g. `UI_VERIFY=1 npm start` — so a server-rendered branch can see it; the browser markers cover client-side animation without it. This is the record-side of the same freeze the Storybook/Vitest skills apply in-browser.

## Diagnosing a flaky diff

1. **Localized band** vs **whole-page shift**? A whole-page shift = something changed the page *height* (a
   variant, missing lazy content, or JS layout), reflowing everything — not a style change.
2. Whole-page → compare `document.body.scrollHeight` across runs. Two discrete values = a flag / third
   party (recipe 1). Continuous variation = JS layout (recipe 6, neutralize it).
3. Content differs = live data (recipe 2) or the clock (recipe 3).

Then upload the archive:
```bash
npx playwright test                       # archives land in uiverify-archive/
uiverify upload --static-dir uiverify-archive
```

## Anti-patterns

- `route.abort()` to block a script → can hang page readiness; use `fulfill(204)`.
- Hand-settling fonts / sticky animation / image decode → UI Verify re-renders and settles those; only
  *content loading* (recipe 5) is your concern.
- Testing live prod with flags on → you're archiving a random variant.
- Unseeded `crypto`/`uuid`/faker or live data → the archive is only as stable as what rendered into it.
