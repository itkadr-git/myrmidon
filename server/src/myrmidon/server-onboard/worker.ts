import { runOnboardWorker } from "./entrypoint.js";

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

runOnboardWorker(process.env, { signal: controller.signal }).catch(() => {
  console.error("Fleet onboarding worker stopped unexpectedly");
  process.exitCode = 1;
});
