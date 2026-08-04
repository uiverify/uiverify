---
name: vitest-visual-testing
description: Make @uiverify/vitest (Vitest browser-mode) captures deterministic so component visual tests stop coming back "changed" without a real change (flaky diffs). Use when setting up or debugging visual tests over Vitest browser-mode component tests. Focuses only on the run-to-run variation the capturer can't neutralize from outside your app — the clock, infinite JS animations, live data, and non-Math.random randomness — plus the one Vitest-specific trap - capturing before the component has settled.
---

# Deterministic Vitest captures (browser mode)

## Mental model — component isolation already removed most of the flake

`@uiverify/vitest` archives each **browser-mode test's final DOM + every resource the page loaded**; UI
Verify re-renders and pixel-diffs that archive server-side. Because a browser-mode component test renders
an **isolated component** (no page scroll, no A/B / analytics / chat / consent scripts, no
lazy-load-on-scroll races), you get the same head start Storybook gives you: the determinism work here is
**narrow**. If you reach for scroll-settling or third-party stubbing, you're fighting a problem component
isolation already removed (that's a real-page concern — see `playwright-visual-testing`).

> Whatever the component **is at the end of the test** (or at your `takeSnapshot()` call) is baked into
> the archive forever. Your job is to drive it to one canonical state before capture.

Integration is one plugin (no per-test code):

```ts
// vitest.config.ts
import { playwright } from '@vitest/browser-playwright';
import { uiverifyPlugin } from '@uiverify/vitest/plugin';
export default defineConfig({
  plugins: [uiverifyPlugin()],
  test: { browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }] } },
});
```

Every browser-mode test then archives its final DOM automatically; `takeSnapshot('name')` adds an
intermediate checkpoint.

**UI Verify's capturer neutralizes these automatically — do NOT hand-fix them:** CSS animations &
transitions (killed at render) and the Web Animations API (disabled); `prefers-reduced-motion: reduce`
(**emulated**); `Math.random` (**seeded** before your app code runs); web fonts and `<img>` loading
(**waited for**); **finite** JS animations (captured at their settled final frame). So the checklist
below is only the remainder — what lives *inside your app*.

## The one Vitest-specific trap: capture before the component settled

The auto-snapshot fires at the **end of a passing test**, and `takeSnapshot()` fires **the moment you
call it**. If the component is still resolving a promise, running a transition, or hasn't rendered its
data yet, you archive a half-rendered frame. Drive it to its final state first — await your render
helper, wait for the content to appear, then let the test end (or call `takeSnapshot()`):

```ts
import { render } from 'vitest-browser-react'; // or your framework's browser render helper
import { takeSnapshot } from '@uiverify/vitest';

test('user card', async () => {
  const screen = await render(<UserCard id="u_1" />); // render() is async - await it, or `screen` is a Promise
  await screen.getByText('Ada Lovelace').query(); // wait for the settled state, THEN archive
  await takeSnapshot();
});
```

This is the analog of a Playwright test's navigation + assertions: your `render` + waits *are* the
determinism surface.

## The checklist (only what the tool can't do for you)

### 1. Freeze the clock

The one thing the capturer deliberately does **not** do. Any component that reads the clock — a relative
timestamp, a date defaulting to "today", a chart's day axis — drifts every run. Pin it with Vitest's fake
timers before you render:

```ts
import { beforeEach, afterEach, vi } from 'vitest';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());
```

If a component animates on mount and fake timers freeze it half-way, advance to the end
(`vi.runAllTimers()`) or set the time *after* the render settles.

### 2. Infinite JS animations

A CSS/WAAPI/finite animation is handled for you (above). What's left is an **infinite** JS loop with no
final frame — framer-motion pulsing dots, a Lottie loop, an autoplay spinner. Two fixes:

- **Preferred — honor reduced motion.** The capturer emulates `prefers-reduced-motion: reduce`, so make
  the component respect it (framer-motion: `<MotionConfig reducedMotion="user">`, or gate the loop with
  `useReducedMotion()`). One line, and it's good app behavior anyway.
- **Escape hatch — detect the capture** and render the end state. UI Verify flags every capture with a
  `UIVerify` marker on the user-agent and a `window.__UI_VERIFY__` global:
  ```ts
  export const isUIVerify = () =>
    (typeof navigator !== 'undefined' && navigator.userAgent.includes('UIVerify')) ||
    (typeof window !== 'undefined' && '__UI_VERIFY__' in window);
  ```
  ```tsx
  <RadarChart isAnimationActive={!isUIVerify()} />
  ```

### 3. Mock live data — never let a test hit a live API

A test that fetches from a real backend is flaky by construction (network, changing data, auth). Return a
fixed fixture — `vi.mock` the data module, or run [MSW](https://mswjs.io/) in the browser via a setup
file — the **same** response every run. Feed the component fixture data and its pixels are stable.

### 4. Non-`Math.random` randomness

`Math.random` is seeded for you, but `crypto.randomUUID()`, a `uuid` library, or faker are **not**. Use
fixed fixtures for anything that reaches the DOM (an id, a faker name), or set a fixed faker seed.

### 5. Dynamic layout

A JS-measured layout that reflows or reorders on its own (packing driven by measured size, a shuffled
list) can vary run-to-run even with identical content. Force a deterministic variant (a fixed
order/size), or mask the region.

## Anti-patterns

- **A test that fetches live data** → mock it (`vi.mock` / MSW).
- **`takeSnapshot()` (or letting the test end) before the component committed or rendered its data** →
  archives a half-rendered or blank frame; `await render(...)` (it is async), then await the settled state.
- **Disabling CSS animations / seeding `Math.random` / waiting on fonts by hand** → wasted effort; the
  capturer already does all three. Spend the effort on the clock, settling, and infinite loops.
- **Unseeded `crypto`/`uuid`/faker or a bare `Date.now()`** → fixtures + freeze the clock.
- **Reaching for scroll-settle / A-B stubbing** → wrong path; that's a real-page concern.
