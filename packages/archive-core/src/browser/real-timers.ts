/** The timers Playwright's clock (`page.clock`) keeps as the real ones once it has replaced the globals; its
 *  own injected scripts read them from here too. Present when the clock was installed before this module
 *  loaded, which an init script registered on the context, or a page script evaluated late, can't avoid. */
function clockBuiltins(): { setTimeout?: unknown; performance?: unknown } {
  const clock: unknown = Reflect.get(globalThis, "__pwClock");
  const builtins: unknown = typeof clock === "object" && clock !== null ? Reflect.get(clock, "builtins") : undefined;
  return typeof builtins === "object" && builtins !== null ? builtins : {};
}

function isPerformance(value: unknown): value is Performance {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "now") === "function";
}

type Timer = (fn: () => void, ms: number) => unknown;

function isTimer(value: unknown): value is Timer {
  return typeof value === "function";
}

const builtins = clockBuiltins();
const timerSource: unknown = isTimer(builtins.setTimeout) ? builtins.setTimeout : globalThis.setTimeout;
const clockSource: unknown = isPerformance(builtins.performance) ? builtins.performance : globalThis.performance;

/** The real timer and clock, captured at module load (before any test body or app code runs), so a test's
 *  fake timers (`vi.useFakeTimers()`, Playwright's `page.clock`) can't stall a capture's waits or move its
 *  deadlines: every bound still fires in wall-clock time. */
export const realSetTimeout: Timer = isTimer(timerSource) ? timerSource.bind(globalThis) : () => 0;
export const realNow: () => number = isPerformance(clockSource) ? clockSource.now.bind(clockSource) : () => Date.now();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(() => resolve(), ms));
}
