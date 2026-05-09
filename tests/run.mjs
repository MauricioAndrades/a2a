import { spawnSync } from "node:child_process";

const files = [
    "tests/parsers.test.mjs",
    "tests/envelope.test.mjs",
    "tests/auth.test.mjs",
    "tests/team-spec.test.mjs",
    "tests/config.test.mjs",
    "tests/reconnect.test.mjs",
];

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
