import { defineConfig } from "@playwright/test";

const browserName = process.env.PLAYWRIGHT_E2E_BROWSER === "firefox" ? "firefox" : "chromium";

export default defineConfig({
  testDir: "tests",
  outputDir: process.env.PLAYWRIGHT_E2E_OUTPUT,
  workers: 1,
  reporter: [["json"]],
  use: { headless: true, browserName },
});
