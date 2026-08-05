import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";

const TEAM_EXTENSIONS = [".yaml", ".yml", ".json"];
const TEAM_EXTENSION_SET = new Set(TEAM_EXTENSIONS);

/**
 * True when the ref already names a spec file by extension. A bare
 * `extname(ref)` check is wrong here: team names may legitimately contain
 * dots (`release-1.2`), which made extname return ".2" and skip the
 * extension candidates, so the team listTeamSpecNames advertised could never
 * be resolved.
 */
function hasTeamSpecExtension(ref) {
  return TEAM_EXTENSION_SET.has(extname(ref).toLowerCase());
}

export class AmbiguousTeamSpecDirectoryError extends Error {
  constructor(dirPath, files) {
    super(
      `ambiguous team spec directory '${dirPath}' contains multiple spec files: ${files.join(", ")}`,
    );
    this.name = "AmbiguousTeamSpecDirectoryError";
  }
}

function parseYaml(raw) {
  const parsed = yaml.load(raw);
  return parsed == null ? {} : parsed;
}

function maybeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isFile(path) {
  return statOrNull(path)?.isFile() === true;
}

function pushUniquePath(refs, seen, path) {
  if (seen.has(path)) return;
  seen.add(path);
  refs.push(path);
}

/** Strip BOM so JSON.parse / yaml.load match files saved by common editors */
function stripUtf8Bom(s) {
  return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s;
}

function looksPathLike(ref) {
  return isAbsolute(ref) || ref.includes("/") || hasTeamSpecExtension(ref);
}

function candidatePaths(ref, cwd, repoTeamsDir, installedTeamsDir) {
  const refs = [];
  const seen = new Set();
  const direct = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const hasSpecExtension = hasTeamSpecExtension(ref);
  const pushDirect = () => {
    pushUniquePath(refs, seen, direct);
    if (!hasSpecExtension) {
      for (const ext of TEAM_EXTENSIONS) {
        pushUniquePath(refs, seen, direct + ext);
      }
    }
  };
  // Path-like refs (absolute, containing a separator, or carrying a spec
  // extension) name a filesystem location, so resolve them literally first.
  // Bare team names prefer the canonical teams directories: otherwise an
  // unrelated directory in cwd that happens to share the team's name
  // shadows the real spec.
  if (looksPathLike(ref)) pushDirect();
  for (const base of [join(cwd, "teams"), repoTeamsDir, installedTeamsDir]) {
    pushUniquePath(refs, seen, join(base, ref));
    if (!hasSpecExtension) {
      for (const ext of TEAM_EXTENSIONS) {
        pushUniquePath(refs, seen, join(base, ref + ext));
      }
    }
  }
  if (!looksPathLike(ref)) pushDirect();
  return refs;
}

/**
 * When a candidate path is a directory, probe inside for a team spec file.
 * Checks for: <dirname>/<dirname>.yaml, <dirname>/team.yaml, and any lone
 * spec file in the directory. Returns the first match or null.
 */
function probeDirectory(dirPath) {
  const dirName = basename(dirPath);
  // Priority 1: <dirname>/<dirname>.<ext>
  for (const ext of TEAM_EXTENSIONS) {
    const named = join(dirPath, dirName + ext);
    if (isFile(named)) return named;
  }
  // Priority 2: <dirname>/team.<ext>
  for (const ext of TEAM_EXTENSIONS) {
    const teamFile = join(dirPath, `team${  ext}`);
    if (isFile(teamFile)) return teamFile;
  }
  // Priority 3: any single spec file in the directory
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    return null;
  }
  const specFiles = entries.filter((f) => {
    const e = extname(f).toLowerCase();
    return TEAM_EXTENSION_SET.has(e);
  });
  if (specFiles.length > 1) {
    throw new AmbiguousTeamSpecDirectoryError(dirPath, specFiles);
  }
  if (specFiles.length === 1) {
    const sole = join(dirPath, specFiles[0]);
    if (isFile(sole)) return sole;
  }
  return null;
}

export function resolveTeamSpecPath(ref, cwd, repoTeamsDir, installedTeamsDir) {
  for (const candidate of candidatePaths(
    ref,
    cwd,
    repoTeamsDir,
    installedTeamsDir,
  )) {
    const stat = statOrNull(candidate);
    if (!stat) continue;
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const found = probeDirectory(candidate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Resolve a user-supplied team spec path (from `--team-file`) WITHOUT the
 * search-path widening that `resolveTeamSpecPath` does. Only tries the
 * literal path:
 *   - absolute → use as-is
 *   - relative → resolve against `launchCwd`
 *   - directory → probe for <dir>/<dir>.yaml, <dir>/team.yaml, or a sole spec
 *   - bare name without extension → try .yaml / .yml / .json siblings
 *
 * Returns the absolute file path on hit, or null if nothing exists at the
 * literal location. Callers raise a precise error on null instead of
 * falling through to other launcher modes.
 */
export function resolveExplicitTeamSpecPath(ref, launchCwd) {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const direct = isAbsolute(ref) ? ref : resolve(launchCwd, ref);
  const candidates = [direct];
  if (!hasTeamSpecExtension(ref)) {
    for (const ext of TEAM_EXTENSIONS) candidates.push(direct + ext);
  }
  for (const candidate of candidates) {
    const stat = statOrNull(candidate);
    if (!stat) continue;
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const found = probeDirectory(candidate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Schema version at which team specs opt INTO yolo-default-true semantics.
 *
 * Old specs (no `version` field, or version < this) keep the pre-yolo-default
 * semantics: a missing `yolo:` means interactive. This preserves replay
 * equivalence — a team spec authored before yolo-default existed cannot
 * silently flip its agents into bypass mode just because someone upgraded a2a.
 *
 * Explicit per-agent or team-default `yolo: true|false` always wins over the
 * schema gate.
 */
export const TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION = 2;

/**
 * Returns true iff the raw spec opts into yolo-default-true via its
 * `version` field. Pure: no I/O, no mutation, accepts any value (including
 * null/undefined/non-objects) and returns false for everything that does not
 * cleanly satisfy `version >= TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION`.
 */
export function teamSpecDefaultsToYolo(rawSpec) {
  const v =
    rawSpec && typeof rawSpec === "object" ? rawSpec.version : undefined;
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+$/.test(v)
        ? Number(v)
        : NaN;
  return Number.isInteger(n) && n >= TEAM_SPEC_YOLO_DEFAULT_TRUE_VERSION;
}

export function parseTeamFlags(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((part) => String(part));
  if (typeof value !== "string")
    throw new Error("team flags must be a string or list");

  const out = [];
  let token = "";
  let quote = null;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (token) {
        out.push(token);
        token = "";
      }
      continue;
    }
    token += ch;
  }

  if (escaped) token += "\\";
  if (quote)
    throw new Error(
      `unterminated ${quote === "'" ? "single" : "double"} quote in team flags`,
    );
  if (token) out.push(token);
  return out;
}

export function teamArgFragments(scope) {
  const s = scope && typeof scope === "object" ? scope : {};
  const args = Array.isArray(s.args) ? s.args.map((arg) => String(arg)) : [];
  return [...args, ...parseTeamFlags(s.flags)];
}

export function mergeTeamArgs(defaults, raw) {
  return [...teamArgFragments(defaults), ...teamArgFragments(raw)];
}

export function loadTeamSpec(specPath) {
  const file = maybeRead(specPath);
  if (file == null) throw new Error(`could not read team spec '${specPath}'`);
  const raw = stripUtf8Bom(file);
  const ext = extname(specPath).toLowerCase();
  let data;
  if (ext === ".json") {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`team spec JSON parse failed '${specPath}': ${msg}`, { cause: e });
    }
  } else if (ext === ".yaml" || ext === ".yml") {
    try {
      data = parseYaml(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`team spec YAML parse failed '${specPath}': ${msg}`, { cause: e });
    }
  } else throw new Error(`unsupported team spec extension '${ext}'`);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("team spec must be a top-level object");
  return data;
}
