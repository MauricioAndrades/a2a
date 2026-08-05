import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [
  "./node_modules/vitest/vitest.mjs",
  "run",
], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
