import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./src/testing/setup-no-network.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Several worktrees run tests at once during development; OO_TEST_WORKERS raises the cap.
    maxWorkers: Number(process.env.OO_TEST_WORKERS ?? 4),
  },
});
