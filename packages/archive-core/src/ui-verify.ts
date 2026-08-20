/**
 * The "is UI Verify capturing this render?" record-time markers, mirrored VERBATIM from the control
 * plane's `@vt/core` `ui-verify.ts` (the SDKs can't import it). The capturer sets the same signals at
 * REPLAY; the SDKs set them at RECORD time - in the customer's own browser, before their app code runs -
 * so a component's `isUIVerify()` is true while we archive. That is what lets author code branch to a
 * deterministic end state under capture (freeze a JS animation, render a loader's final frame, drop a
 * live clock) while keeping the real behaviour in production.
 *
 * `isUIVerify()` reads either of two signals, so keep BOTH identical to `@vt/core` or detection silently
 * breaks (the two never import from each other - they are matched by hand):
 *  - `UI_VERIFY_UA_MARKER` appended to `navigator.userAgent` (the portable primitive `/docs/is-ui-verify`
 *    advertises; reaches workers, and survives an app replacing `navigator`), and
 *  - `UI_VERIFY_GLOBAL` on `window` (for contexts that can't read the UA).
 */

/** Appended to `navigator.userAgent` on every UI Verify capture; the SDKs set it at record time on the
 *  browser context they own. Matches `@vt/core`'s `UI_VERIFY_UA_MARKER`. */
export const UI_VERIFY_UA_MARKER = "UIVerify";

/** The window global an init script sets before any app code runs; `isUIVerify()` reads it. */
export const UI_VERIFY_GLOBAL = "__UI_VERIFY__";

/** The script the SDKs run at record time - Playwright `addInitScript`, or evaluated at Vitest
 *  browser-setup load - to flag the page before the app renders. */
export const UI_VERIFY_MARKER_SCRIPT = `globalThis.${UI_VERIFY_GLOBAL} = true;`;

/** Append the UI Verify marker to a browser's real user-agent, keeping the base UA intact - so UA
 *  sniffing in the app under test still sees a real browser. Matches `@vt/core`'s `uiVerifyUserAgent`. */
export function uiVerifyUserAgent(baseUserAgent: string): string {
  return `${baseUserAgent} ${UI_VERIFY_UA_MARKER}`;
}
