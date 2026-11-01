---
name: bun-visual-testing
description: Make @uiverify/bun captures deterministic so Bun visual tests (bun test driving Chrome through Bun.WebView) stop coming back "changed" without a real change (flaky diffs). Use when setting up or debugging visual tests written with @uiverify/bun, on a real page of your running app (run() with webServer) or on a component page served by serveBundle(). Focuses only on the run-to-run variation the SDK can't neutralize from outside your app — above all live/dynamic data, the highest-value step (freeze it with fixtures or page.route and the whole content-noise class disappears), plus the clock, infinite JS animations, non-Math.random randomness, fonts a measuring component reads before they load, and the Bun-specific setup traps.
---

# Deterministic Bun captures (`@uiverify/bun`)

## Mental model — the page at the moment of capture is baked in

`@uiverify/bun` runs your visual tests on `bun test`, drives the Chrome you have installed through
`Bun.WebView`, and archives each test's **final page: the serialized DOM + every resource it uses**. UI
Verify re-renders and pixel-diffs that archive server-side.

> Whatever the page **is at the end of the test** (or at your `takeSnapshot()` call) is baked into the
> archive forever. Your job is to drive it to one canonical state before capture.

There are two ways to point a test at UI, and they decide how much of this skill applies:

- **A real page of your running app** (surface-specific): `run({ webServer })` starts your app and the
  tests `page.goto("/…")` it. Everything a real page brings comes with it: API calls, feature flags,
  third-party scripts, server rendering. This is the Playwright-style path.
- **A component page** (surface-specific): `serveBundle({ entrypoint })` builds an HTML entry that mounts
  just the components under test and serves it, with no app server. Like Storybook and Vitest browser mode,
  component isolation removes most of the flake (no A/B / analytics / chat scripts, no SSR), so the
  determinism work is **narrow**.

Integration is a suite, a test file, and a runner:

```ts
// tests/visual/fixtures.ts
import { DEFAULT_VIEWPORT, defineSuite, type Viewports } from '@uiverify/bun';

const viewports: Viewports = { '': DEFAULT_VIEWPORT, mobile: { width: 390, height: 844 } };
export const visualSuite = defineSuite({ viewports }, (page) => {
  // Runs at the start of every test: suite-wide routes and init scripts.
  page.route('**/api/flags', (route) => route.fulfill({ json: { newCheckout: false } }));
});

// tests/visual/home.visual.ts
import { expect } from '@uiverify/bun';
import { visualSuite } from './fixtures';
const { describe, test } = visualSuite(import.meta.path);

describe('Home', () => {
  test('signed out', async (page) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  });
});

// tests/visual/run.ts — `bun tests/visual/run.ts`, then `npx uiverify upload --static-dir uiverify-archive`
import { run } from '@uiverify/bun/run';
process.exitCode = await run({
  // The server gets PORT and must listen on it. `ready` is the start of the line it prints once it
  // serves (matched as a prefix); leave it out to wait for the port instead.
  webServer: { command: ['bun', 'server.ts'], port: 3000, ready: 'Listening' },
});
```

Type the viewports as `Viewports` (as above) so a `describe` or test can override them with a different
set. Every viewport entry runs the test once and is its own snapshot.

**What `@uiverify/bun` pins for you — do NOT hand-fix these.** In every document, before your app's
scripts run:

- the page **clock** starts at the suite's `now` (default `2026-01-01T00:00:00Z`, UTC unless it names an
  offset) and runs from there;
- `Math.random` is **seeded**;
- CSS **animations and transitions finish instantly**, and the text caret never blinks into a capture;
- the **timezone** is UTC, the **locale** en-US (including `navigator.language`), `prefers-reduced-motion:
  reduce` is **emulated**, and `prefers-color-scheme` is the suite's `colorScheme` (default `light`);
- `loading="lazy"` images load up front, and scrollbars are hidden.

Before each snapshot it **waits** up to 3 s for the fonts in use, up to 3 s for every image and CSS
background, then until nothing on the page moves. Each test starts on a blank page with no routes or init
scripts, the storage of every origin the previous test touched cleared, no cookies and no history. An
uncaught page error, an unhandled rejection or a route handler that throws fails the test, so a broken page
fails the run instead of passing quietly.

So the checklist below is only the remainder — what lives *inside your app*.

**The headline: freeze the data.** Once the list above is off the table, the one thing left that floods a
suite with false "changes" is **live/dynamic data** — star counts, follower counts, contributor lists,
tiles, timestamps. Feed every page and component **static fixtures** and that entire class disappears at
the source: static data can't churn run-to-run, so there is nothing to diff. This is the single
highest-value determinism step here — do it first (step 1), and most tests need nothing else.

## The checklist (only what the SDK can't do for you)

### 1. Freeze the data — the one that actually matters

A page fed live data is flaky by construction: the stars, followers, contributor list, tile order and
timestamps move between runs, so the diff lights up with no code change. Never let a visual test hit a real
backend. Feed fixed, ordered, complete fixtures: literal counts, a fixed author list (names **and** avatar
URLs, in a fixed order), a fixed set of rows in a fixed order, fixed timestamps (pair with the clock, step
2).

**On a real page, answer the API with `page.route`** (Bun-specific API, Playwright's shape). Put the routes
every test needs in the suite's setup function, and per-test ones at the top of the test:

```ts
test('dashboard', async (page) => {
  page.route('**/api/projects', (route) => route.fulfill({ json: fixtures.projects }));
  page.route(/\/api\/stats/, (route) => route.fulfill({ json: { stars: 12873 } }));
  await page.goto('/dashboard');
  await expect(page.getByText('12,873')).toBeVisible();
});
```

- A pattern is a Playwright URL glob or a RegExp; a relative glob resolves against the suite's base URL.
  The latest-registered matching route answers first; `route.fallback()` passes to the next one, then the
  network.
- **Register routes before the first `goto`.** Chrome's cache persists between tests: a route always sees
  the requests of a test's first page, but a second `goto` in the same test may take assets from memory.
- **Stub feature-flag and third-party scripts** (real page only) with `route.fulfill({ status: 204 })` so
  one fixed variant renders: the script "loads" empty and the page renders its control DOM.
- **A cross-site iframe isn't routed** (surface-specific): it runs in a process of its own, so its requests
  bypass your routes, and it gets no init scripts, no pinned clock, and no storage reset between tests.
  Mask it (step 7) or keep it out of the capture.

**On a component page, hand the fixtures in as props** from the entry (or the scene it renders), exactly as
a Storybook story or a Vitest test would. A component page has no backend to call; if a component fetches
internally, route that URL the same way.

### 2. The clock — pinned at the start, still running

The SDK fakes `Date` in the page and starts it at the suite's `now`, so "today", a calendar, a year or a
chart's day axis renders the same every run. Set `now` where a test needs a particular date: on the suite,
a `describe`, or one test (`test('…', body, { now: '2024-06-01T09:00:00Z' })`).

The clock still **runs** from that start, so by the time a test acts it has moved on by however long the
page took to load. Anything that renders at a finer grain than the run's few seconds — a clock with seconds,
a countdown, "updated 3 s ago" — differs by how fast the test ran, and pausing afterwards can't take that
back: render it from a fixture timestamp (a prop, or a routed API response) or mask it (section 7).

What `page.pauseClock()` does hold is **timers**: a timeout that comes due waits for `resumeClock()` and
intervals skip, so a toast that hides itself or a carousel that advances stays where it is:

```ts
await page.goto('/status');
await page.pauseClock(); // Date stands still; timeouts that come due wait for resumeClock(); intervals skip
```

Or wait the timer out with assertions: first that the toast appeared, then that it's gone
(`.not.toBeVisible()` alone also passes before the toast renders), so the snapshot never races it.

**A real page's server clock is not pinned** (surface-specific): only the page's `Date` is. A date the server
renders into the HTML comes from the server's own time; pin it in the server code under `UI_VERIFY`
(step 5).

### 3. Infinite JS animations

CSS animations and transitions are handled for you (above). What's left is an **infinite** JS loop with no
final frame — framer-motion pulsing dots, a Lottie loop, an autoplay spinner, or a `<canvas>` /
`requestAnimationFrame` loop (which no media query can reach). Before a snapshot the SDK waits for the page
to stop moving, and **fails the test after 10 s** naming the element that kept changing, so a moving
element is loud. A `<canvas>` that keeps redrawing **in place** isn't detected: it's captured mid-frame and
diffs every run, silently. Fixes:

- **Preferred — honor reduced motion.** The SDK emulates `prefers-reduced-motion: reduce`, so make the
  component respect it (framer-motion: `<MotionConfig reducedMotion="user">`, or gate the loop with
  `useReducedMotion()`; in CSS, `@media (prefers-reduced-motion: reduce) { .spinner { animation: none } }`).
  One line, and it's good app behavior anyway.
- **Test-only switch for Motion (framer-motion).** `MotionGlobalConfig.skipAnimations = true` (from
  `motion/react` or `framer-motion`) makes every Motion animation jump to its end state. Set it in the
  component page's entry, or behind `isUIVerify()` in the app.
- **Escape hatch — detect the capture** and render the end state (for a `<canvas>` rAF loop:
  `if (isUIVerify()) drawOneStaticFrame(); else startRaf();` in the effect). The canonical helper reads
  two signals — a `UIVerify` `navigator.userAgent` marker and a `window.__UI_VERIFY__` global:
  ```ts
  export const isUIVerify = () =>
    (typeof navigator !== 'undefined' && navigator.userAgent.includes('UIVerify')) ||
    (typeof window !== 'undefined' && '__UI_VERIFY__' in window);
  ```
  ```tsx
  <RadarChart isAnimationActive={!isUIVerify()} />
  ```
  Under `@uiverify/bun` the load-bearing signal is the `window.__UI_VERIFY__` global (the SDK's page
  script sets it before your app's scripts; it doesn't change the user agent) — use the helper as-is. On a
  real page that decides this during **server rendering**, also read `process.env.UI_VERIFY`: `run()`
  starts every web server with `UI_VERIFY=1` (step 5).

### 4. Non-`Math.random` randomness

`Math.random` is seeded for you, but `crypto.randomUUID()`, a `uuid` library, or faker are **not**. Use
fixed fixtures for anything that reaches the DOM (an id, a faker name), or set a fixed faker seed.

### 5. A random pick or "now" made on the server (real page only)

In an SSR app the server renders the HTML, so a `Math.random()` pick (a hero image, a shuffled list) or a
server-side `new Date()` is already in the page before the browser's seeding or clock can touch it — a
whole different element each run. Pin it in the component and let real users keep the randomness:

```tsx
const isUIVerify = () =>
  (typeof process !== 'undefined' && !!process.env.UI_VERIFY) ||     // server render
  (typeof window !== 'undefined' && '__UI_VERIFY__' in window);     // browser
const src = isUIVerify() ? images[0] : images[Math.floor(Math.random() * images.length)];
```

`run()` already sets `UI_VERIFY=1` on the web servers it starts, so the server and the browser agree on
the fixed variant (otherwise React throws a hydration mismatch). If a layout still varies after the
animation is gated (particle seeds, item order), the component is drawing from the **global** sequence that
other code consumes first by a timing-dependent amount: give it its own small reset-able RNG (a xorshift)
used under capture.

### 6. Fonts — load them from the app, and before a component measures text

The SDK waits for the fonts **in use** before each snapshot; it can't wait for a font the page never
declares. Serve fonts from an npm package (`@fontsource/*`) or a same-origin file, not a font CDN, so the
bytes come from your own app. To confirm a font is declared,
`(await document.fonts.load('16px "Inter"')).length` must be above `0`; don't use `document.fonts.check()`,
which returns `true` for a family no `@font-face` declares.

**A component that measures its text on mount** (a sliding tab highlight, a truncation, a fitted label) on a
component page: the SDK's font wait comes after the measurement, which then used fallback metrics and is
baked in a pixel off. Have the entry load the fonts before it renders (surface-specific):

```ts
// tests/visual/components/scenes.tsx
await document.fonts.load('600 16px "Inter"');
createRoot(rootEl).render(<Scene />);
```

### 7. Mask what you can't pin

Last resort for content that is supposed to differ and can't be pinned at the source (a third-party
embed, a map, an ad slot, a live feed): add **`data-uiverify-ignore`** to the element. UI Verify paints
its box solid black on every capture, so its content never reaches the diff. The box's size and position
still diff (give it a fixed size), and nothing inside it is checked, so mask only what you can't pin and
fix what you own. [Docs](https://uiverify.ai/docs/ignore-regions).

```tsx
<aside data-uiverify-ignore style={{ width: 320, height: 256 }}><AdSlot /></aside>
```

A JS-measured layout that reflows or reorders on its own (packing driven by measured size, a shuffled
list) can vary run-to-run even with identical content: force a deterministic variant (a fixed order/size),
or mask it.

## Capture the settled state, not the loading one

The snapshot fires when the test ends (a failed test is snapshotted too, so a broken page shows up as a
visual change rather than vanishing from the build), or the moment you `await takeSnapshot('name')`. The SDK
waits for fonts, images and motion, but not for **data**: if the page is still showing a skeleton when the
test ends, the skeleton is what's archived. Assert the **real content** before the capture, with an element
that only exists once the data has rendered, and wait for everything the page loads, not only the part you
assert on:

```ts
await page.goto('/orders');
await expect(page.getByRole('row', { name: /Order #1042/ })).toBeVisible(); // retries up to 15 s
await takeSnapshot('loaded');
```

`page.waitUntil(description, check)` polls any condition you can express with locators. Await every
`takeSnapshot()`: a test that leaves one un-awaited fails.

**Content that mounts when it scrolls into view** (real page): the tab never scrolls, so a section, list or
embed gated on an `IntersectionObserver` stays a placeholder in the capture. `loading="lazy"` images are
handled for you; a component that waits to be visible isn't. Render it eagerly under `isUIVerify()`.

## Bun-specific setup traps

- **`run()`'s test processes ignore your app's `bunfig.toml`.** A test preload such as happy-dom replaces
  `fetch`, which the SDK needs, so the runner keeps it out. The flip side: fixtures and test files must not
  import modules that need a loader, plugin or `define` registered there.
- **`serveBundle()` builds with `Bun.build`, which reads no bunfig and inlines no env.** Pass `plugins`
  (e.g. `bun-plugin-tailwind`) and `define` (a `process.env.PUBLIC_*` the components read) explicitly. Name
  the HTML entry `index.html`: that is the page served at `/`, with every other built file at its own path.
  Point the file's suite at it and stop it when the file ends:
  ```ts
  const preview = await serveBundle({ entrypoint: `${import.meta.dir}/components/index.html` });
  afterAll(() => preview.stop());
  const { test } = visualSuite(import.meta.path, { baseUrl: preview.url });
  ```
- **`page.addInitScript(fn)` sends `fn` as source**: it can't use variables from around it.
- **One tab per file, one test at a time.** `bun test --parallel` is refused; `run()` runs files in
  parallel itself, and `shards: { 'tests/visual/big.visual.ts': 4 }` splits a large file across processes.
- **A tab the page opens** (`target=_blank`, `window.open`) is closed at once; the test stays on its page.
- **Capture in CI on Linux.** A baseline captured on a Mac renders text differently, so every Linux run
  would diff against it. The SDK needs Bun 1.3.12+ and Chrome or Chromium (`BUN_CHROME_PATH` for another);
  GitHub's Ubuntu runners have Chrome preinstalled.

Then upload the archive:

```bash
bun tests/visual/run.ts                          # archives land in uiverify-archive/
npx uiverify upload --static-dir uiverify-archive
```

**Copy the example — it's the reference implementation.**
[`examples/bun`](https://github.com/uiverify/uiverify/tree/main/examples/bun) captures the same storefront
both ways: every screen of the running app at two viewports, a shopping flow with a snapshot after each step,
and components in isolation on a `serveBundle()` page.

## Anti-patterns

- **A test that reaches a live backend** → `page.route` fixtures (real page) or fixture props (component
  page).
- **Registering a route after `goto`** → the first page's requests already went out; register first.
- **Ending the test (or calling `takeSnapshot()`) before the data rendered** → archives a skeleton; assert
  the real content first.
- **Disabling CSS animations / seeding `Math.random` / waiting on fonts before a snapshot by hand** → wasted
  effort; the SDK already does all three. Spend the effort on data, the running clock, and infinite loops.
- **Unseeded `crypto`/`uuid`/faker, or a server-rendered `Math.random()` / date** → fixtures, and pin the
  server under `UI_VERIFY`.
- **Accepting baselines captured on a Mac** → capture in CI on Linux.
