import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": srcDir } },
});
