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
    const raw = maybeRead(specPath);
    if (raw == null) throw new Error(`could not read team spec '${specPath}'`);
    const ext = extname(specPath).toLowerCase();
    let data;
    if (ext === ".json") data = JSON.parse(raw);
    else if (ext === ".yaml" || ext === ".yml") data = parseYaml(raw);
    else throw new Error(`unsupported team spec extension '${ext}'`);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("team spec must be a top-level object");
    return data;
}
