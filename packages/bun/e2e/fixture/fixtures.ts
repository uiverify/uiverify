import { DEFAULT_VIEWPORT, defineSuite, type SuiteOptions } from "../../dist/index.js";

export const suite = defineSuite<SuiteOptions & { greeting: string }>(
  { viewports: { "": DEFAULT_VIEWPORT }, greeting: "hello" },
  (page) => {
    page.route("**/api/never", () => new Promise(() => {}));
  },
);
