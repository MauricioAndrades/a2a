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

test("loadTeamSpec accepts UTF-8 BOM on JSON files (editor interoperability)", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-teambom-"));
    const spec = join(dir, "team.json");
    const body = JSON.stringify({
        name: "bom",
        agents: [{ id: "ralph", backend: "claude" }],
    });
    writeFileSync(spec, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]));
    const data = loadTeamSpec(spec);
    assert.equal(data.name, "bom");
    assert.equal(data.agents[0].id, "ralph");
});

test("loadTeamSpec wraps YAML syntax errors with the spec path", () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-yaml-bad-"));
    const spec = join(dir, "broken.yaml");
    writeFileSync(spec, "agents: [\n  - not closed\n", "utf8");
    assert.throws(() => loadTeamSpec(spec), /team spec YAML parse failed .*broken\.yaml/);
});
