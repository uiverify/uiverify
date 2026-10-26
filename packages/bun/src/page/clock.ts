/** The page's clock: starts at `start` (epoch ms) and runs in real time until paused. While paused, `Date`
 *  stands still, a timeout that comes due waits and runs on resume, and an interval's ticks are skipped.
 *  Installed before the app's own scripts, so whatever renders "now" (a calendar, a relative time) is the
 *  same on every run. */
export function installClock(start: number): { pause(): void; resume(): void } {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  let offset = start - realNow();
  let pausedAt: number | null = null;
  const now = () => pausedAt ?? realNow() + offset;

  const FakeDate = new Proxy<DateConstructor>(RealDate, {
    apply: () => new RealDate(now()).toString(),
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
    get: (target, property, receiver) => (property === "now" ? now : Reflect.get(target, property, receiver)),
  });
  Reflect.set(globalThis, "Date", FakeDate);

  const realSetTimeout = setTimeout;
  const realSetInterval = setInterval;
  const realClearTimeout = clearTimeout;
  /** Timeouts that came due while paused, by id, so clearing one still cancels it. */
  const held = new Map<ReturnType<typeof setTimeout>, () => void>();
  // A string handler is code, as the browser's own timers take it.
  const callable = (fn: TimerHandler): ((...args: unknown[]) => unknown) => {
    const code = typeof fn === "function" ? fn : Function(fn);
    return (...args) => Reflect.apply(code, globalThis, args);
  };
  Reflect.set(globalThis, "setTimeout", (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const handler = callable(fn);
    const id = realSetTimeout(() => {
      if (pausedAt === null) handler(...args);
      else held.set(id, () => handler(...args));
    }, ms);
    return id;
  });
  Reflect.set(globalThis, "clearTimeout", (id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) held.delete(id);
    realClearTimeout(id);
  });
  Reflect.set(globalThis, "setInterval", (fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const handler = callable(fn);
    return realSetInterval(() => {
      if (pausedAt === null) handler(...args);
    }, ms);
  });

  return {
    pause() {
      pausedAt = now();
    },
    resume() {
      if (pausedAt === null) return;
      offset = pausedAt - realNow();
      pausedAt = null;
      const due = [...held.values()];
      held.clear();
      for (const run of due) {
        try {
          run();
        } catch (error) {
          // Reported as the page's own uncaught error, as the timer would have; the rest still run.
          realSetTimeout(() => {
            throw error;
          }, 0);
        }
      }
    },
  };
}
