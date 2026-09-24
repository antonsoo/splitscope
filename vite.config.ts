/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "/splitscope/",
  // The synthetic sample .lss files live in examples/ (see docs/format.md and the
  // sample generator script) and double as Vite's public dir, so "Load sample" fetches
  // the same files in dev and in the built/deployed site without duplicating them.
  publicDir: "examples",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**"],
    },
  },
});
