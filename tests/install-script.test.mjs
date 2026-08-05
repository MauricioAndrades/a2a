import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = join(repoRoot, "scripts", "install.mjs");
const homes = [];

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "a2a-install-home-"));
  homes.push(home);
  return home;
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/**
 * Run the real installer in a child process against an isolated $HOME
 * (os.homedir() honours $HOME on POSIX). stdin is closed and not a TTY, so
 * any interactive prompt cannot be answered.
 *
 * Two steps are disabled by default because, unlike every other step, they
 * reach outside the isolated $HOME:
 *   - the key step writes to <repo>/config.json, i.e. the real checkout;
 *   - the ngrok step can shell out to brew/snap to install a system package.
 * Tests that need them opt in explicitly.
 *
 * SHELL is pinned so the PATH step resolves to a predictable profile file
 * instead of depending on whoever runs the suite.
 */
function runInstaller({ home, args = [], env = {} }) {
  return spawnSync(process.execPath, [installerPath, ...args], {
    encoding: "utf8",
    timeout: 180_000,
    input: "",
    env: {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      CI: "",
      A2A_SETUP_YES: "",
      A2A_SETUP_NO_KEY: "1",
      A2A_SETUP_NO_NGROK: "1",
      NO_COLOR: "1",
      ...env,
    },
  });
}

describe.sequential("scripts/install.mjs", () => {
  test("CI=true (GitHub Actions) runs unattended like CI=1", () => {
    // Regression: only CI === "1" enabled auto-yes, so CI=true environments
    // blocked on rl.question with a non-tty stdin.
    const home = freshHome();
    const result = runInstaller({ home, env: { CI: "true" } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("a2a setup (--yes)");
  });

  test("a dangling ~/.local/bin/a2a symlink is replaced instead of aborting", async () => {
    // Regression: existsSync follows symlinks, so a dangling link looked
    // absent and the unconditional symlinkSync aborted the installer with
    // EEXIST.
    const home = freshHome();
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const danglingDest = join(binDir, "a2a");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(home, "no-such-target"), danglingDest);

    const result = runInstaller({ home, args: ["--yes"] });

    // Before the fix the installer aborted with EEXIST (exit 1) and the
    // dangling link survived. Now the run succeeds and the link is repaired.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("linked commands in");
    expect(readlinkSync(danglingDest)).toBe(join(repoRoot, "bin", "a2a.mjs"));
  });

  test("sample team step installs the tracked star-wars.yaml spec", () => {
    // Regression: the step pointed at teams/bug-killers.yaml, which was
    // removed from the repo in c7826bb, so it was permanently "skipped:
    // source team spec not found".
    const home = freshHome();
    const result = runInstaller({ home, args: ["--yes"] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("source team spec not found");

    const installedSpec = join(
      home,
      ".claude",
      "skills",
      "a2a",
      "teams",
      "star-wars.yaml",
    );
    expect(readFileSync(installedSpec, "utf8")).toBe(
      readFileSync(join(repoRoot, "teams", "star-wars.yaml"), "utf8"),
    );
  });

  test("the a2a SKILL.md actually lands in ~/.claude/skills/a2a", () => {
    // Regression: the source path was built as `skill/a2a/SKILL.md` (singular)
    // while the repo ships `skills/a2a/SKILL.md`. Every install printed
    // "skipped: skill/a2a/SKILL.md not found in package", exited 0, and then
    // listed the missing file under "locations" as if it were installed. No
    // test asserted the file existed, which is how it survived.
    const home = freshHome();
    const result = runInstaller({ home, args: ["--yes"] });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("not found in package");

    const installedSkill = join(home, ".claude", "skills", "a2a", "SKILL.md");
    expect(readFileSync(installedSkill, "utf8")).toBe(
      readFileSync(join(repoRoot, "skills", "a2a", "SKILL.md"), "utf8"),
    );
  });

  test("the a2a-team-harness skill installs with its references and assets", () => {
    // Regression: this skill ships in the repo but had no install step at all.
    const home = freshHome();
    const result = runInstaller({ home, args: ["--yes"] });

    expect(result.status).toBe(0);

    const harness = join(home, ".claude", "skills", "a2a-team-harness");
    expect(readFileSync(join(harness, "SKILL.md"), "utf8")).toBe(
      readFileSync(
        join(repoRoot, "skills", "a2a-team-harness", "SKILL.md"),
        "utf8",
      ),
    );
    // Sub-directories must come along, not just the top-level SKILL.md.
    expect(
      existsSync(join(harness, "references", "topologies.md")),
    ).toBe(true);
    expect(
      existsSync(join(harness, "assets", "team-spec.example.yaml")),
    ).toBe(true);
  });

  test("verification executes the CLI instead of stat-ing the symlink", () => {
    // Regression: the verify step only lstat'd the link and checked the exec
    // bit, so a checkout with no node_modules reported "a2a is ready" and then
    // died with ERR_MODULE_NOT_FOUND on the first command.
    const home = freshHome();
    const result = runInstaller({ home, args: ["--yes"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("`a2a help` runs");
  });

  test("the bin dir is added to the shell profile exactly once", () => {
    const home = freshHome();

    const first = runInstaller({ home, args: ["--yes"] });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("added PATH line to");

    const zshrc = join(home, ".zshrc");
    const afterFirst = readFileSync(zshrc, "utf8");
    expect(afterFirst).toContain('export PATH="$HOME/.local/bin:$PATH"');

    // Re-running must not append a duplicate.
    const second = runInstaller({ home, args: ["--yes"] });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already puts");

    const occurrences = readFileSync(zshrc, "utf8").split(
      "# added by a2a install",
    ).length - 1;
    expect(occurrences).toBe(1);
  });

  test("--no-path leaves the shell profile alone", () => {
    const home = freshHome();
    const result = runInstaller({ home, args: ["--yes", "--no-path"] });

    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  test("an operator key is generated when the config has none", () => {
    // `a2a start --global` refuses to run without a key, so a fresh install
    // could never do a cross-machine session. This step writes to the real
    // checkout's config.json, so the file is saved and put back.
    const configPath = join(repoRoot, "config.json");
    const existed = existsSync(configPath);
    const original = existed ? readFileSync(configPath, "utf8") : null;

    try {
      writeFileSync(
        configPath,
        `${JSON.stringify({ key: null }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const home = freshHome();
      const result = runInstaller({
        home,
        args: ["--yes"],
        env: { A2A_SETUP_NO_KEY: "" },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("generated operator key");

      const written = JSON.parse(readFileSync(configPath, "utf8"));
      expect(typeof written.key).toBe("string");
      expect(written.key.startsWith("a2a-")).toBe(true);
    } finally {
      if (original === null) rmSync(configPath, { force: true });
      else writeFileSync(configPath, original, { mode: 0o600 });
    }
  });

  test("--no-ngrok skips ngrok setup without failing the install", () => {
    // NOTE: the neighbouring guard — "under CI, never auto-install ngrok via
    // brew/snap" — is deliberately NOT covered here. commandExists() probes
    // with `sh -lc`, and a login shell rebuilds PATH from /etc/profile, so a
    // present ngrok binary cannot be hidden from the installer by overriding
    // PATH in the test env. That branch is unverified by test.
    const home = freshHome();
    const result = runInstaller({
      home,
      args: ["--yes", "--no-ngrok"],
      env: { A2A_SETUP_NO_NGROK: "" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skipped --no-ngrok");
    expect(result.stdout).toContain("ngrok          skipped (--no-ngrok)");
  });

  test("verification catches a CLI that cannot run and exits non-zero", () => {
    // Regression: the installer exited 0 and printed "a2a is ready" whenever
    // the symlink merely existed, even if running it was impossible. Here a
    // non-executable stub occupies the destination, so the link is refused
    // (existing files are never clobbered) and `a2a` cannot be executed.
    const home = freshHome();
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "a2a"), "", { mode: 0o644 });

    const result = runInstaller({ home, args: ["--yes"] });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("could not execute");
    expect(result.stdout).toContain("this install is not usable yet");
  });
});
