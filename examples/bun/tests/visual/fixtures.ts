import { DEFAULT_VIEWPORT, defineSuite, type Viewports } from "@uiverify/bun";

// Typed as Viewports, so a test or describe can override them with a different set.
const viewports: Viewports = { "": DEFAULT_VIEWPORT, mobile: { width: 390, height: 844 } };

/** Every test runs at a desktop and a mobile viewport, so a layout regression at either width is caught. */
export const visualSuite = defineSuite({ viewports });
