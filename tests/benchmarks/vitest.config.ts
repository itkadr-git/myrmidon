import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "benchmarks",
    include: ["**/*.test.ts"],
    environment: "node",
  },
});
