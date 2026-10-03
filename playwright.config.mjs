import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  workers: 2,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4330/splitscope/",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: `"${process.execPath}" node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4330 --strictPort`,
    wait: { stdout: /http:\/\/127\.0\.0\.1:4330\/splitscope\// },
  },
});
