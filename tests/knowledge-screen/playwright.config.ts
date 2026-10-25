import { defineConfig } from "@playwright/test";

// OPE-5957 / OPE-9222: real-render check of the Knowledge screen (UI2 and the
// current UI) at 1920x1080 and 1366x768. The harness is a vite dev server of
// ui/knowledge-qa.html; the REST API is answered by the spec itself.
const PORT = 5188;
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}) },
    },
  ],
  webServer: {
    command: "pnpm --filter @myrmidon/ui exec vite --config vite.knowledge-qa.config.mjs",
    url: `http://127.0.0.1:${PORT}/knowledge-qa.html`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
