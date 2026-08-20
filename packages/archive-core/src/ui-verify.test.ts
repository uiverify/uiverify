import { describe, expect, it } from "vitest";
import { UI_VERIFY_GLOBAL, UI_VERIFY_MARKER_SCRIPT, UI_VERIFY_UA_MARKER, uiVerifyUserAgent } from "./ui-verify";

describe("UI Verify record-time marker", () => {
  it("sets the exact global that the control plane's isUIVerify() reads", () => {
    // A typo in the global name or the script silently breaks capture detection (the app never learns it
    // is being archived), so pin both against the value @vt/core checks, and prove the script sets it.
    expect(UI_VERIFY_GLOBAL).toBe("__UI_VERIFY__");

    const sandbox: Record<string, unknown> = {};
    new Function("globalThis", UI_VERIFY_MARKER_SCRIPT)(sandbox);
    expect(sandbox[UI_VERIFY_GLOBAL]).toBe(true);
  });

  it("pins the user-agent marker @vt/core appends and isUIVerify() matches on", () => {
    // The UA branch of isUIVerify() (advertised by /docs/is-ui-verify) matches on this exact token, so a
    // drift here silently breaks detection for the SDK that sets it at the browser context it owns.
    expect(UI_VERIFY_UA_MARKER).toBe("UIVerify");
  });

  it("appends the marker to a real user-agent without discarding the base", () => {
    // The base UA must survive so UA sniffing in the app under test still sees a real browser; the marker
    // is a space-delimited suffix that isUIVerify()'s `includes()` finds.
    const base = "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0.0.0";
    const ua = uiVerifyUserAgent(base);
    expect(ua).toBe(`${base} ${UI_VERIFY_UA_MARKER}`);
    expect(ua.includes(UI_VERIFY_UA_MARKER)).toBe(true);
    expect(ua.startsWith(base)).toBe(true);
  });
});
