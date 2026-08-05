function escapeRegExp(source) {
  return source.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export function hasUnescapedGlob(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "*" || ch === "?") return true;
  }
  return false;
}

export function globPatternToRegExp(pattern, { caseInsensitive = true } = {}) {
  let source = "^";
  let escaped = false;

  for (const ch of pattern) {
    if (escaped) {
      source += escapeRegExp(ch);
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "*") {
      source += ".*";
      continue;
    }
    if (ch === "?") {
      source += ".";
      continue;
    }
    source += escapeRegExp(ch);
  }

  if (escaped) source += "\\\\";
  source += "$";
  return new RegExp(source, caseInsensitive ? "i" : "");
}

/**
 * Remove glob-escaping backslashes from a literal selector. `web\*` selects
 * the agent literally named `web*` — the backslash is selector syntax, not
 * part of the recipient id.
 *
 * @param {string} value
 * @returns {string}
 */
function unescapeGlobSelector(value) {
  return value.replace(/\\([*?\\])/g, "$1");
}

export function expandGlobRecipientSelectors(selectors, candidates) {
  const uniqueCandidates = [];
  const seenCandidates = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || seenCandidates.has(candidate)) continue;
    seenCandidates.add(candidate);
    uniqueCandidates.push(candidate);
  }

  const resolved = [];
  const seenResolved = new Set();
  const unmatched = [];
  const addResolved = (recipient) => {
    if (seenResolved.has(recipient)) return;
    seenResolved.add(recipient);
    resolved.push(recipient);
  };

  for (const selector of Array.isArray(selectors) ? selectors : []) {
    if (!selector) continue;
    if (!hasUnescapedGlob(selector)) {
      addResolved(unescapeGlobSelector(selector));
      continue;
    }
    const matcher = globPatternToRegExp(selector, { caseInsensitive: true });
    let matched = false;
    for (const candidate of uniqueCandidates) {
      if (!matcher.test(candidate)) continue;
      matched = true;
      addResolved(candidate);
    }
    if (!matched) {
      unmatched.push(selector);
    }
  }

  return {
    recipients: resolved,
    unmatchedSelectors: unmatched,
  };
}
