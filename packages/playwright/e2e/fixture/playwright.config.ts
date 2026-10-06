import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  outputDir: process.env.PLAYWRIGHT_E2E_OUTPUT,
  workers: 1,
  reporter: [["json"]],
  use: { headless: true },
});
