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
`prefers-reduced-motion` emulated and fonts and images settled. So pixel-level settling — waiting on
`document.fonts.ready`, sticky-header animation, image decode — is **not** your job. Your job is
narrower: make sure the **content and state** the archive records is the same every run.

One caveat on "animations": the freeze is **replay-side**, via reduced-motion emulation — the archive
does **not** bake a frozen frame. A CSS animation that honors `prefers-reduced-motion` freezes for free;
an **infinite** CSS/JS animation that ignores it keeps running on replay and lands on a random frame
(recipe 8), and a `<canvas>`/`requestAnimationFrame` loop is beyond the media query entirely (recipe 9).
Those live inside your app, so the fix does too.

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
| A different logo/mascot/hero or list order each run — a whole-*element* diff, not a pixel shift | **`Math.random()` in the render body**, run at **SSR time** in Next.js/Remix | **Pin the variant on `isUIVerify()`** + `UI_VERIFY=1` on the app server → recipe 10 |
| An infinite CSS keyframe animation on a different frame | **CSS animation that ignores `prefers-reduced-motion`** | **Honor the media query in the app's CSS** → recipe 8 |
| A `<canvas>` (particles, chart, background) diffs every run | **`requestAnimationFrame` loop** the media query can't reach | **Draw one static frame on `isUIVerify()`** → recipe 9 |
| The capture is a skeleton / spinner, not the loaded page | **Snapshot fired before the data arrived** | **Wait for the real content** (`networkidle`) → recipe 12 |

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

## Determinism the app itself owns (real-app cases a stub can't reach)

The recipes above pin variation from **outside** the app — routes, the clock, the DOM. The next five
live where a stub can't reach: **inside your components** (a branch on `isUIVerify()`, recipe 7's helper,
or the app's own CSS) or in **what the test waits for**. These are the ones that eat an afternoon if you
fight them from the test, especially under SSR.

**8. Infinite CSS animation lands on a random frame** — a rotating illustration, a pulsing dot. The
freeze is replay-side (see the mental model): the worker emulates `prefers-reduced-motion: reduce` and
re-runs the archived CSS, so the animation stops **only if the app honors that media query**. Add it to
the app's CSS — not the test:
```css
@media (prefers-reduced-motion: reduce) { .rotating-logo { animation: none } }
```
Use `animation: none`, **never `animation-duration: 0s`** — 0s leaves an infinite animation on its own
compositor layer and it sub-pixel-flakes (~1/100). No `isUIVerify()` needed here; the media query is the
whole lever. (**FAILED:** setting `reducedMotion` in the test/config is a **no-op at record time** — the
archive never bakes the computed transform, so there's nothing to freeze until replay. Don't reach for
it. Also: `reducedMotion` is not a top-level Playwright `use` option anyway — it lives under
`use: { contextOptions: { reducedMotion: 'reduce' } }` — but you don't need it at all.)

**9. A `<canvas>` / `requestAnimationFrame` animation diffs every run** — particles, a chart, an animated
background. rrweb bakes the canvas pixels (`rr_dataURL`) at the instant of capture, catching a different
frame each time. A media query can't reach a JS rAF loop, so branch in the component's effect:
```tsx
useEffect(() => {
  if (isUIVerify()) drawOneStaticFrame();   // one deterministic frame under capture
  else startRaf();                          // the live loop for real users
}, []);
```
**FAILED:** emulating `prefers-reduced-motion` in the test *does* set `matchMedia(...).matches = true` in
the page, but a hand-written rAF loop never reads it and keeps animating — the guard has to be in the JS.

**10. A random pick made *in render* changes the element each run** — a mascot/logo/hero image chosen by
`Math.random()`, a shuffled list. Not a pixel shift: a **different element**, a large whole-element diff,
every run. This is the biggest real-app time-sink. In any SSR framework (Next.js, Remix) the pick runs at
**server render time** and the archive bakes the SSR'd choice, so a browser-side fix can't touch it. Pin
the variant in the component and let real users keep the randomness:
```tsx
const src = isUIVerify() ? images[0] : images[Math.floor(Math.random() * images.length)];
```
Because the pick is server-side, **set `UI_VERIFY=1` on the app server for the capture run** (recipe 7)
so SSR and the client agree on the fixed variant — otherwise they disagree and React throws a hydration
mismatch. **FAILED (do not repeat):** seeding `Math.random` from a Playwright `addInitScript` fixture —
it patches the *browser* RNG, which cannot reach a pick React already made on the server; seeded captures
still rolled different sprites. (Redefining `navigator.userAgent` from an init script fails too — it's
why the marker is set at context creation, not in-page.)

**11. Even after gating the animation, a canvas/grid *layout* still differs** — the frame is static but
the square positions, particle seeds, or item order move run-to-run. The layout is drawing from the
**global** `Math.random`, and seeding it globally is **not enough**: React and other components consume
the shared sequence first, by an amount that varies with render timing, so your component gets different
values each capture. Give that component its **own reset-able RNG** (a tiny xorshift), reset at the start
of each generation, used only under capture — then its output is byte-identical across runs.

**12. The capture is a skeleton / spinner, not the loaded page** — the test asserted something (a URL, a
button) and the auto-capture fired before the *data* arrived. Wait for the **real content**, not its
container: a data row, `role="tab"`, a specific project link — or `page.waitForLoadState('networkidle')`.
**TRAP:** a generic selector like `a[href^="/project/"]` can match a **stale** link still in the DOM
during a client-side transition and resolve too early, capturing the loading state. Prefer `networkidle`
or a selector for an element that only exists once the *new* content has rendered.

**Freezing live/dynamic data (stars, followers, tiles, listings)** is recipe 2 — `page.route` with
committed fixtures is fork-friendly where a private staging backend isn't reachable in CI. If the noise
is heavy and content-driven, the higher-leverage move is often to lift those cases into **Storybook or
Vitest with mocked data** (`storybook-visual-testing` / `vitest-visual-testing`): static data = no
content churn at the source, and one component per canvas keeps the volume down.

> **Ops, not determinism:** fork PRs, the maintainer-approval flow, the Playwright-container CI
> (browser-install hang), and git `safe.directory` are **not** in this skill — see
> [`/docs/open-source-and-forks`](https://uiverify.ai/docs/open-source-and-forks). This skill is only the
> runnable determinism playbook.

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
