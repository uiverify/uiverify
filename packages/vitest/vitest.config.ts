import { defineConfig } from "vitest/config";

// The package's OWN unit tests are pure Node (the id derivation). The browser-mode capture path is
// verified end-to-end against a real Vitest browser run, not here.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    globals: false,
  },
});
