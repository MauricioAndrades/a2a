import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/*.test.mjs", "tests/*vitest.test.mjs"],
    fileParallelism: false,
    watch: false,
  },
});