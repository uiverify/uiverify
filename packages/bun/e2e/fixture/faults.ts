import { FAULTS, type Fault, type Faults } from "../../src/faults";

/** Set this file's faults, which the built SDK finds on `globalThis`; returned so the file can change them. */
export function injectFaults(faults: Faults): Faults {
  Reflect.set(globalThis, FAULTS, faults);
  return faults;
}

/** Say that a fault fired, so the e2e can tell a test that reached its fault from one that passed without it. */
export function fired(call: string, fault: Fault): Fault {
  console.log(`[fault] ${call.slice(0, 40)}: ${fault}`);
  return fault;
}

/** A fault for the first call `matches` accepts, then none. */
export function once(matches: (call: string) => boolean, fault: Fault): (call: string) => Fault | undefined {
  let used = false;
  return (call) => {
    if (used || !matches(call)) return undefined;
    used = true;
    return fired(call, fault);
  };
}
