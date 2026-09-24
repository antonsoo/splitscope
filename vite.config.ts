/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "/splitscope/",
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
