/**
 * For this package's e2e suite only, and not exported: a fixture file sets a {@link Faults} on `globalThis` under
 * {@link FAULTS} before it defines its suite, to reach the paths a healthy browser never takes. Only a build made
 * with `UIVERIFY_BUN_FAULTS=1` (the e2e suite's) reads it; every other build, the published one included, has
 * {@link ENABLED} fixed to false, so the global is never read and every call is sent as is.
 */
export const FAULTS = Symbol.for("@uiverify/bun e2e faults");

const ENABLED = process.env.UIVERIFY_BUN_FAULTS === "1";

/** Never answer, fail, or answer that many ms after the browser did. */
export type Fault = "hang" | "fail" | number;

export interface Faults {
  /** Read when a test is declared, so a fixture can change it between declarations. */
  testTimeoutMs?: number;
  /** The budget of a reopen inside a test. */
  openTimeoutMs?: number;
  /** The budget of the browser's first start, before the first test. */
  startupTimeoutMs?: number;
  /** How long a start or a first page load takes before it is reported as slow. */
  slowMs?: number;
  /** Called for each browser call: `<lane> <method>` for CDP (`page Page.enable`), an evaluated script, an
   *  input's label, or `"open"` (the first navigation of a new view). */
  fault?: (call: string) => Fault | undefined;
}

function hook(name: keyof Faults): unknown {
  if (!ENABLED) return undefined;
  const faults: unknown = Reflect.get(globalThis, FAULTS);
  return typeof faults === "object" && faults !== null ? Reflect.get(faults, name) : undefined;
}

export function timeoutWithFaults(name: "testTimeoutMs" | "openTimeoutMs" | "startupTimeoutMs" | "slowMs", ms: number): number {
  const value = hook(name);
  return typeof value === "number" ? value : ms;
}

export async function sendWithFaults<T>(call: string, send: () => Promise<T>): Promise<T> {
  const fault = hook("fault");
  const decided: unknown = typeof fault === "function" ? fault(call) : undefined;
  if (decided === "hang") return new Promise<never>(() => {});
  if (decided === "fail") throw new Error(`@uiverify/bun: ${call} failed (an injected fault)`);
  const answer = await send();
  if (typeof decided === "number") await Bun.sleep(decided);
  return answer;
}
