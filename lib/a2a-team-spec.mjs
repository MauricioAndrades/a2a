import { existsSync, readFileSync, statSync } from "fs";
import { extname, isAbsolute, join, resolve } from "path";

const TEAM_EXTENSIONS = [".yaml", ".yml", ".json"];

function stripYamlComment(line) {
    let out = "";
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
            if (ch === quote && line[i - 1] !== "\\") quote = null;
            out += ch;
            continue;
        }
        if (ch === "'" || ch === "\"") {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "#") break;
        out += ch;
    }
    return out.replace(/\s+$/, "");
}

function tokenizeYaml(raw) {
    return raw
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line, idx) => {
            const clean = stripYamlComment(line);
            if (!clean.trim()) return null;
            const indent = clean.match(/^ */)[0].length;
            return { line: idx + 1, indent, text: clean.slice(indent) };
        })
        .filter(Boolean);
}

function parseScalar(text) {
    const value = text.trim();
    if (value === "") return "";
    if (value === "null" || value === "~") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function parseBlockScalar(tokens, index, indent, style) {
    const parts = [];
    let i = index;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.indent < indent) break;
        const relative = token.indent - indent;
        parts.push(" ".repeat(relative) + token.text);
        i++;
    }
    return {
        value: style === ">"
            ? parts.map((p) => p.trim()).join(" ").trim()
            : parts.join("\n"),
        nextIndex: i,
    };
}

function splitKeyValue(text) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote && text[i - 1] !== "\\") quote = null;
            continue;
        }
        if (ch === "'" || ch === "\"") {
            quote = ch;
            continue;
        }
        if (ch === ":") {
            const key = text.slice(0, i).trim();
            const rest = text.slice(i + 1).trim();
            if (!key) break;
            return { key, rest };
        }
    }
    return null;
}

function parseNode(tokens, index, indent) {
    if (index >= tokens.length) return { value: null, nextIndex: index };
    const token = tokens[index];
    if (token.indent < indent) return { value: null, nextIndex: index };
    if (token.indent > indent) throw new Error(`line ${token.line}: unexpected indentation`);
    if (token.text.startsWith("- ")) return parseSequence(tokens, index, indent);
    return parseMapping(tokens, index, indent);
}

function parseSequence(tokens, index, indent) {
    const items = [];
    let i = index;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.indent < indent) break;
        if (token.indent > indent) throw new Error(`line ${token.line}: unexpected indentation in list`);
        if (!token.text.startsWith("- ")) break;

        const rest = token.text.slice(2).trim();
        if (!rest) {
            const nested = parseNode(tokens, i + 1, indent + 2);
            items.push(nested.value);
            i = nested.nextIndex;
            continue;
        }

        const pair = splitKeyValue(rest);
        if (pair) {
            const obj = {};
            if (pair.rest === "|" || pair.rest === ">") {
                const block = parseBlockScalar(tokens, i + 1, indent + 2, pair.rest);
                obj[pair.key] = block.value;
                i = block.nextIndex;
            } else if (pair.rest === "") {
                const nested = parseNode(tokens, i + 1, indent + 2);
                obj[pair.key] = nested.value;
                i = nested.nextIndex;
            } else {
                obj[pair.key] = parseScalar(pair.rest);
                i += 1;
            }
            while (i < tokens.length) {
                const next = tokens[i];
                if (next.indent < indent + 2) break;
                if (next.indent > indent + 2) throw new Error(`line ${next.line}: unexpected indentation in list object`);
                if (next.text.startsWith("- ")) break;
                const entry = splitKeyValue(next.text);
                if (!entry) throw new Error(`line ${next.line}: expected key: value`);
                if (entry.rest === "|" || entry.rest === ">") {
                    const block = parseBlockScalar(tokens, i + 1, indent + 4, entry.rest);
                    obj[entry.key] = block.value;
                    i = block.nextIndex;
                    continue;
                }
                if (entry.rest === "") {
                    const nested = parseNode(tokens, i + 1, indent + 4);
                    obj[entry.key] = nested.value;
                    i = nested.nextIndex;
                    continue;
                }
                obj[entry.key] = parseScalar(entry.rest);
                i += 1;
            }
            items.push(obj);
            continue;
        }

        items.push(parseScalar(rest));
        i += 1;
    }
    return { value: items, nextIndex: i };
}

function parseMapping(tokens, index, indent) {
    const obj = {};
    let i = index;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token.indent < indent) break;
        if (token.indent > indent) throw new Error(`line ${token.line}: unexpected indentation in mapping`);
        if (token.text.startsWith("- ")) break;
        const pair = splitKeyValue(token.text);
        if (!pair) throw new Error(`line ${token.line}: expected key: value`);
        if (pair.rest === "|" || pair.rest === ">") {
            const block = parseBlockScalar(tokens, i + 1, indent + 2, pair.rest);
            obj[pair.key] = block.value;
            i = block.nextIndex;
            continue;
        }
        if (pair.rest === "") {
            const nested = parseNode(tokens, i + 1, indent + 2);
            obj[pair.key] = nested.value;
            i = nested.nextIndex;
            continue;
        }
        obj[pair.key] = parseScalar(pair.rest);
        i += 1;
    }
    return { value: obj, nextIndex: i };
}

function parseYaml(raw) {
    const tokens = tokenizeYaml(raw);
    if (tokens.length === 0) return {};
    const parsed = parseNode(tokens, 0, tokens[0].indent);
    return parsed.value;
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
