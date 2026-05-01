import { parseArgs } from 'node:util'

// Canonical flag concepts that exist across CLIs.
// Each key is a semantic concept. Values are per-CLI flag shapes.
// `null` means the CLI has no equivalent for this concept.
const FLAG_REGISTRY = new Map(Object.entries({
  model: {
    claude:       { flag: '--model',           value: 'string' },
    codex:        { flag: '--model',           value: 'string', alias: '-m' },
    gemini:       { flag: '--model',           value: 'string', alias: '-m' },
    'cursor-agent': null,
  },
  print: {
    claude:       { flag: '--print',           value: 'boolean', alias: '-p' },
    codex:        null,
    gemini:       { flag: '--prompt',          value: 'boolean', alias: '-p' },
    'cursor-agent': null,
  },
  continue: {
    claude:       { flag: '--continue',        value: 'boolean', alias: '-c' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  resume: {
    claude:       { flag: '--resume',          value: 'string', alias: '-r' },
    codex:        null,
    gemini:       { flag: '--resume',          value: 'string', alias: '-r' },
    'cursor-agent': null,
  },
  debug: {
    claude:       { flag: '--debug',           value: 'boolean' },
    codex:        null,
    gemini:       { flag: '--debug',           value: 'boolean', alias: '-d' },
    'cursor-agent': null,
  },
  version: {
    claude:       { flag: '--version',         value: 'boolean', alias: '-v' },
    codex:        null,
    gemini:       { flag: '--version',         value: 'boolean', alias: '-v' },
    'cursor-agent': null,
  },
  sandbox: {
    claude:       null,
    codex:        { flag: '--sandbox',         value: 'enum', allowed: ['read-only', 'workspace-write', 'danger-full-access'], alias: '-s' },
    gemini:       { flag: '--sandbox',         value: 'boolean', alias: '-s' },
    'cursor-agent': null,
  },
  yolo: {
    claude:       { flag: '--dangerously-skip-permissions', value: 'boolean' },
    codex:        { flag: '--dangerously-bypass-approvals-and-sandbox', value: 'boolean', alias: '--yolo' },
    gemini:       { flag: '--yolo',            value: 'boolean', alias: '-y' },
    'cursor-agent': null,
  },
  systemPrompt: {
    claude:       { flag: '--system-prompt',   value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  appendSystemPrompt: {
    claude:       { flag: '--append-system-prompt', value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  systemPromptFile: {
    claude:       { flag: '--system-prompt-file', value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  maxTurns: {
    claude:       { flag: '--max-turns',       value: 'number' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  maxBudget: {
    claude:       { flag: '--max-budget-usd',  value: 'number' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  outputFormat: {
    claude:       { flag: '--output-format',   value: 'enum', allowed: ['text', 'json', 'stream-json'] },
    codex:        { flag: '--json',            value: 'boolean' },
    gemini:       { flag: '--output-format',   value: 'enum', allowed: ['text', 'json', 'stream-json'], alias: '-o' },
    'cursor-agent': null,
  },
  allowedTools: {
    claude:       { flag: '--allowedTools',    value: 'string[]' },
    codex:        null,
    gemini:       { flag: '--allowed-tools',   value: 'string[]' },
    'cursor-agent': null,
  },
  disallowedTools: {
    claude:       { flag: '--disallowedTools', value: 'string[]' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  mcpConfig: {
    claude:       { flag: '--mcp-config',      value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  addDir: {
    claude:       { flag: '--add-dir',         value: 'string' },
    codex:        { flag: '--add-dir',         value: 'string' },
    gemini:       { flag: '--include-directories', value: 'string' },
    'cursor-agent': null,
  },
  approvalMode: {
    claude:       { flag: '--permission-mode', value: 'string' },
    codex:        { flag: '--ask-for-approval', value: 'enum', allowed: ['on-request', 'never'], alias: '-a' },
    gemini:       { flag: '--approval-mode',   value: 'enum', allowed: ['default', 'auto_edit', 'yolo'] },
    'cursor-agent': null,
  },
  worktree: {
    claude:       { flag: '--worktree',        value: 'boolean', alias: '-w' },
    codex:        null,
    gemini:       { flag: '--worktree',        value: 'boolean', alias: '-w' },
    'cursor-agent': null,
  },
  verbose: {
    claude:       { flag: '--verbose',         value: 'boolean' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  agent: {
    claude:       { flag: '--agent',           value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  name: {
    claude:       { flag: '--name',            value: 'string', alias: '-n' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  effort: {
    claude:       { flag: '--effort',          value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  fallbackModel: {
    claude:       { flag: '--fallback-model',  value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  fullAuto: {
    claude:       null,
    codex:        { flag: '--full-auto',       value: 'boolean' },
    gemini:       null,
    'cursor-agent': null,
  },
  profile: {
    claude:       null,
    codex:        { flag: '--profile',         value: 'string', alias: '-p' },
    gemini:       null,
    'cursor-agent': null,
  },
  config: {
    claude:       null,
    codex:        { flag: '--config',          value: 'string', alias: '-c' },
    gemini:       null,
    'cursor-agent': null,
  },
  image: {
    claude:       null,
    codex:        { flag: '--image',           value: 'string', alias: '-i' },
    gemini:       null,
    'cursor-agent': null,
  },
  promptInteractive: {
    claude:       null,
    codex:        null,
    gemini:       { flag: '--prompt-interactive', value: 'boolean', alias: '-i' },
    'cursor-agent': null,
  },
  skipTrust: {
    claude:       null,
    codex:        null,
    gemini:       { flag: '--skip-trust',      value: 'boolean' },
    'cursor-agent': null,
  },
  screenReader: {
    claude:       null,
    codex:        null,
    gemini:       { flag: '--screen-reader',   value: 'boolean' },
    'cursor-agent': null,
  },
  extensions: {
    claude:       null,
    codex:        null,
    gemini:       { flag: '--extensions',      value: 'string[]', alias: '-e' },
    'cursor-agent': null,
  },
  remote: {
    claude:       { flag: '--remote',          value: 'boolean' },
    codex:        { flag: '--remote',          value: 'string' },
    gemini:       null,
    'cursor-agent': null,
  },
  settingSources: {
    claude:       { flag: '--setting-sources', value: 'string' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  bare: {
    claude:       { flag: '--bare',            value: 'boolean' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  init: {
    claude:       { flag: '--init',            value: 'boolean' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  teleport: {
    claude:       { flag: '--teleport',        value: 'boolean' },
    codex:        null,
    gemini:       null,
    'cursor-agent': null,
  },
  oss: {
    claude:       null,
    codex:        { flag: '--oss',             value: 'boolean' },
    gemini:       null,
    'cursor-agent': null,
  },
  search: {
    claude:       null,
    codex:        { flag: '--search',          value: 'boolean' },
    gemini:       null,
    'cursor-agent': null,
  },
}))

const CLIS = ['claude', 'codex', 'gemini', 'cursor-agent']

// Build reverse index: flag string -> { cli, concept, spec }
function buildFlagIndex() {
  const index = new Map()
  for (const [concept, cliMap] of FLAG_REGISTRY) {
    for (const cli of CLIS) {
      const spec = cliMap[cli]
      if (!spec) continue
      index.set(`${cli}:${spec.flag}`, { cli, concept, spec })
      if (spec.alias) {
        for (const a of Array.isArray(spec.alias) ? spec.alias : [spec.alias]) {
          index.set(`${cli}:${a}`, { cli, concept, spec })
        }
      }
    }
  }
  return index
}

const FLAG_INDEX = buildFlagIndex()

// All known flags per CLI for detection scoring
function knownFlagsFor(cli) {
  const flags = new Set()
  for (const [, cliMap] of FLAG_REGISTRY) {
    const spec = cliMap[cli]
    if (!spec) continue
    flags.add(spec.flag)
    if (spec.alias) {
      for (const a of Array.isArray(spec.alias) ? spec.alias : [spec.alias]) {
        flags.add(a)
      }
    }
  }
  return flags
}

const KNOWN_FLAGS = new Map(CLIS.map(cli => [cli, knownFlagsFor(cli)]))

// Unique flags: flags that exist in only one CLI (strong signals for detection)
function buildUniqueFlags() {
  const flagToClis = new Map()
  for (const [cli, flags] of KNOWN_FLAGS) {
    for (const f of flags) {
      if (!flagToClis.has(f)) flagToClis.set(f, [])
      flagToClis.get(f).push(cli)
    }
  }
  const unique = new Map()
  for (const [flag, clis] of flagToClis) {
    if (clis.length === 1) unique.set(flag, clis[0])
  }
  return unique
}

const UNIQUE_FLAGS = buildUniqueFlags()

// Tokenize raw argv string into tokens, respecting quotes and JSON
function tokenize(raw) {
  const tokens = []
  let i = 0
  while (i < raw.length) {
    if (raw[i] === ' ' || raw[i] === '\t') { i++; continue }

    if (raw[i] === "'" || raw[i] === '"') {
      const quote = raw[i]
      let depth = 0
      let j = i + 1
      while (j < raw.length) {
        if (raw[j] === '{') depth++
        if (raw[j] === '}') depth--
        if (raw[j] === quote && depth <= 0) break
        j++
      }
      tokens.push(raw.slice(i + 1, j))
      i = j + 1
      continue
    }

    let j = i
    while (j < raw.length && raw[j] !== ' ' && raw[j] !== '\t') j++
    tokens.push(raw.slice(i, j))
    i = j
  }
  return tokens
}

// Extract flags from tokens as key-value pairs
function extractFlags(tokens) {
  const flags = []
  const positionals = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.startsWith('--') || (t.startsWith('-') && t.length === 2 && !t.match(/^-\d/))) {
      if (t.includes('=')) {
        const eq = t.indexOf('=')
        flags.push({ flag: t.slice(0, eq), value: t.slice(eq + 1) })
      } else {
        const next = tokens[i + 1]
        if (next && !next.startsWith('-')) {
          flags.push({ flag: t, value: next })
          i += 2
          continue
        }
        flags.push({ flag: t, value: true })
      }
    } else {
      positionals.push(t)
    }
    i++
  }
  return { flags, positionals }
}

// Detect which CLI format the flags are in
function detectFormat(flags) {
  const scores = new Map(CLIS.map(c => [c, 0]))

  for (const { flag } of flags) {
    const unique = UNIQUE_FLAGS.get(flag)
    if (unique) {
      scores.set(unique, scores.get(unique) + 10)
      continue
    }
    for (const cli of CLIS) {
      if (KNOWN_FLAGS.get(cli).has(flag)) {
        scores.set(cli, scores.get(cli) + 1)
      }
    }
  }

  let best = null
  let bestScore = 0
  for (const [cli, score] of scores) {
    if (score > bestScore) { best = cli; bestScore = score }
  }
  return best
}

// Resolve a flag to its canonical concept given a source CLI
function resolveConcept(flag, sourceCli) {
  const entry = FLAG_INDEX.get(`${sourceCli}:${flag}`)
  if (entry) return entry.concept
  return null
}

// Transform parsed flags from one CLI format to another
function transformParsedFlags(parsedFlags, sourceCli, targetCli) {
  const result = { translated: [], dropped: [], passthrough: [] }

  for (const { flag, value } of parsedFlags) {
    const concept = resolveConcept(flag, sourceCli)
    if (!concept) {
      result.passthrough.push({ flag, value, reason: 'unknown flag, passed through' })
      continue
    }

    const targetSpec = FLAG_REGISTRY.get(concept)?.[targetCli]
    if (!targetSpec) {
      result.dropped.push({ flag, value, concept, reason: `${targetCli} has no equivalent for '${concept}'` })
      continue
    }

    let targetValue = value
    if (concept === 'outputFormat') {
      if (sourceCli === 'codex' && flag === '--json') {
        targetValue = targetSpec.value === 'boolean' ? true : 'json'
      }
      if (targetCli === 'codex' && targetSpec.flag === '--json') {
        targetValue = true
      }
    }

    result.translated.push({
      sourceFlag: flag,
      targetFlag: targetSpec.flag,
      value: targetValue,
      concept,
    })
  }

  return result
}

// Serialize transform result back to argv string
function serialize(result) {
  const parts = []
  for (const { targetFlag, value } of result.translated) {
    if (value === true) {
      parts.push(targetFlag)
    } else {
      const needsQuote = typeof value === 'string' && (value.includes(' ') || value.includes('{'))
      parts.push(`${targetFlag} ${needsQuote ? `'${value}'` : value}`)
    }
  }
  for (const { flag, value } of result.passthrough) {
    if (value === true) {
      parts.push(flag)
    } else {
      const needsQuote = typeof value === 'string' && (value.includes(' ') || value.includes('{'))
      parts.push(`${flag} ${needsQuote ? `'${value}'` : value}`)
    }
  }
  return parts.join(' ')
}

// Main entry point
export function transformFlags(argv, targetCli, sourceCli) {
  if (!CLIS.includes(targetCli)) {
    throw new Error(`Unknown target CLI: ${targetCli}. Known: ${CLIS.join(', ')}`)
  }

  const tokens = typeof argv === 'string' ? tokenize(argv) : argv
  const { flags, positionals } = extractFlags(tokens)

  const detected = sourceCli ?? detectFormat(flags)
  if (!detected) {
    return { error: 'Could not detect source CLI format', flags, positionals }
  }

  const result = transformParsedFlags(flags, detected, targetCli)
  const argv_out = serialize(result)

  return {
    source: detected,
    target: targetCli,
    argv: argv_out,
    positionals,
    translated: result.translated,
    dropped: result.dropped,
    passthrough: result.passthrough,
  }
}

// Extension API: register a new CLI or add flags to an existing one
export function registerCli(cli) {
  if (!CLIS.includes(cli)) CLIS.push(cli)
  KNOWN_FLAGS.set(cli, knownFlagsFor(cli))
}

export function registerFlag(concept, cli, spec) {
  if (!FLAG_REGISTRY.has(concept)) {
    const entry = Object.fromEntries(CLIS.map(c => [c, null]))
    FLAG_REGISTRY.set(concept, entry)
  }
  FLAG_REGISTRY.get(concept)[cli] = spec
  // Rebuild indices
  KNOWN_FLAGS.set(cli, knownFlagsFor(cli))
  const idx = buildFlagIndex()
  for (const [k, v] of idx) FLAG_INDEX.set(k, v)
}

export { FLAG_REGISTRY, CLIS, KNOWN_FLAGS, UNIQUE_FLAGS }

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const targetIdx = args.findIndex(a => a === '--target' || a === '-t')
  if (targetIdx === -1) {
    console.error('Usage: transform-flags.mjs --target <cli> [--source <cli>] <flags...>')
    console.error('  --target, -t   Target CLI format (claude|codex|gemini|cursor-agent)')
    console.error('  --source       Source CLI format (auto-detected if omitted)')
    console.error('')
    console.error('Example:')
    console.error('  node transform-flags.mjs --target codex --model claude-3-opus --yolo --verbose')
    process.exit(1)
  }

  const target = args[targetIdx + 1]
  const sourceIdx = args.findIndex(a => a === '--source')
  const source = sourceIdx !== -1 ? args[sourceIdx + 1] : undefined

  const flagArgs = args.filter((_, i) => {
    if (i === targetIdx || i === targetIdx + 1) return false
    if (sourceIdx !== -1 && (i === sourceIdx || i === sourceIdx + 1)) return false
    return true
  })

  const result = transformFlags(flagArgs, target, source)
  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }

  console.log(JSON.stringify(result, null, 2))
}
