import { describe, expect, it } from "vitest";
import { UI_VERIFY_GLOBAL, UI_VERIFY_MARKER_SCRIPT } from "./ui-verify";

describe("UI Verify record-time marker", () => {
  it("sets the exact global that the control plane's isUIVerify() reads", () => {
    // A typo in the global name or the script silently breaks capture detection (the app never learns it
    // is being archived), so pin both against the value @vt/core checks, and prove the script sets it.
    expect(UI_VERIFY_GLOBAL).toBe("__UI_VERIFY__");

    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", UI_VERIFY_MARKER_SCRIPT)(sandbox);
    expect(sandbox[UI_VERIFY_GLOBAL]).toBe(true);
  });
});
