/**
 * The "is UI Verify capturing this render?" record-time marker, mirrored VERBATIM from the control
 * plane's `@vt/core` `ui-verify.ts` (the SDKs can't import it). The capturer sets the same signal at
 * REPLAY; the SDKs set it at RECORD time - in the customer's own browser, before their app code runs -
 * so a component's `isUIVerify()` is true while we archive. That is what lets author code branch to a
 * deterministic end state under capture (freeze a JS animation, render a loader's final frame, drop a
 * live clock) while keeping the real behaviour in production.
 *
 * Keep `UI_VERIFY_GLOBAL` and `UI_VERIFY_MARKER_SCRIPT` identical to `@vt/core` or detection silently
 * breaks (the two never import from each other - they are matched by hand).
 */

/** The window global an init script sets before any app code runs; `isUIVerify()` reads it. */
export const UI_VERIFY_GLOBAL = "__UI_VERIFY__";

/** The script the SDKs run at record time - Playwright `addInitScript`, or evaluated at Vitest
 *  browser-setup load - to flag the page before the app renders. */
export const UI_VERIFY_MARKER_SCRIPT = `globalThis.${UI_VERIFY_GLOBAL} = true;`;
