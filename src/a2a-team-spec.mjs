import { existsSync, readFileSync, statSync } from "fs";
import { extname, isAbsolute, join, resolve } from "path";
import yaml from "js-yaml";

const TEAM_EXTENSIONS = [".yaml", ".yml", ".json"];

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

/** Strip BOM so JSON.parse / yaml.load match files saved by common editors */
function stripUtf8Bom(s) {
    return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s;
}

function candidatePaths(ref, cwd, repoTeamsDir, installedTeamsDir) {
    const refs = [];
    const direct = isAbsolute(ref) ? ref : resolve(cwd, ref);
    refs.push(direct);
    if (!extname(ref)) {
        for (const ext of TEAM_EXTENSIONS) refs.push(direct + ext);
    }
    for (const base of [join(cwd, "teams"), repoTeamsDir, installedTeamsDir]) {
        refs.push(join(base, ref));
        if (!extname(ref)) {
            for (const ext of TEAM_EXTENSIONS) refs.push(join(base, ref + ext));
        }
    }
    return [...new Set(refs)];
}

export function resolveTeamSpecPath(ref, cwd, repoTeamsDir, installedTeamsDir) {
    for (const candidate of candidatePaths(ref, cwd, repoTeamsDir, installedTeamsDir)) {
        if (!existsSync(candidate)) continue;
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            // ignore
        }
    }
    return null;
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
            throw new Error(`team spec JSON parse failed '${specPath}': ${msg}`);
        }
    } else if (ext === ".yaml" || ext === ".yml") {
        try {
            data = parseYaml(raw);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`team spec YAML parse failed '${specPath}': ${msg}`);
        }
    } else throw new Error(`unsupported team spec extension '${ext}'`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("team spec must be a top-level object");
    return data;
}
