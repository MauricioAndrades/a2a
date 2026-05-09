import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTeamSpec } from "../src/a2a-team-spec.mjs";

test("loads YAML team specs with block scalars and lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-team-"));
    const spec = join(dir, "team.yaml");
    writeFileSync(spec, [
        "name: sample",
        "dashboard: true",
        "agents:",
        "  - id: bob",
        "    backend: claude",
        "    cwd: /tmp",
        "    role: |",
        "      hello",
        "      there",
    ].join("\n"));
    const data = loadTeamSpec(spec);
    assert.equal(data.name, "sample");
    assert.equal(data.dashboard, true);
    assert.equal(data.agents[0].id, "bob");
    assert.match(data.agents[0].role, /hello\nthere/);
});
