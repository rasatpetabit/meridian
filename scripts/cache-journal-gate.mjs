#!/usr/bin/env bun
// Summarize Meridian journal cache behavior for one time window.
// Port of the validated journal gate: same counts, same 100k write threshold.
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const REQUEST = /^\[PROXY\] (\S+) adapter=\S+ .*?lineage=(\S+).*?msgs=(.*)$/
// Meridian omits cache_read= when nothing was read.
const USAGE = /^\[PROXY\] (\S+) usage: .*?(?:cache_read=(\S+) )?cache_write=(\S+)/
const TOKEN = /^([0-9.]+)([kM]?)$/
const WRITE_THRESHOLD = 100_000
const HELP = `Usage: bun scripts/cache-journal-gate.mjs (--since <time> [--until <time>] | --file=<path>)

Summarize one Meridian journal window: requests by lineage, cache writes of
at least 100k tokens, evictions by reason, and new-lineage requests whose
message tail contains two or more tool results.

--since and --until are passed through to:
  journalctl --user -u meridian.service --no-pager -o cat
ISO-8601 timestamps with an explicit offset are accepted, for example 2026-11-15T00:34:58-08:00.
A bare local time is read in the process timezone: a systemd-run unit without TZ reads it as UTC, which silently widened an earlier scheduled report to 8 hours of pre-install traffic.

--file=<path> reads saved journal text instead of journalctl (tests and offline use).
`

/** Journal token counts use a k or M suffix. Unparseable text is zero. */
export function parseTokenCount(text) {
  const match = TOKEN.exec(text)
  if (!match) return 0
  const scale = match[2] === "k" ? 1e3 : match[2] === "M" ? 1e6 : 1
  return Math.trunc(Number(match[1]) * scale)
}

function countToken(haystack, needle) {
  return haystack.split(needle).length - 1
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** String reason, "?" when the field is absent, or null when the line cannot be parsed. */
function evictionReason(line) {
  const start = line.indexOf("{")
  if (start < 0) return null
  let parsed
  try {
    parsed = JSON.parse(line.slice(start))
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  if (!Object.hasOwn(parsed, "reason")) return "?"
  const reason = parsed.reason
  if (typeof reason !== "string" && typeof reason !== "number" && typeof reason !== "boolean") return null
  return String(reason)
}

/**
 * @param {string} text journalctl -o cat text, or the same lines saved to a file
 */
export function summarizeJournal(text) {
  const lineage = new Map()
  const tail = new Map()
  const writes = new Map()
  const reads = new Map()
  const evictions = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue
    const request = REQUEST.exec(line)
    if (request) {
      const id = request[1]
      lineage.set(id, request[2])
      const parts = request[3].split(" → ")
      tail.set(id, parts[parts.length - 1] ?? "")
      continue
    }
    const usage = USAGE.exec(line)
    if (usage) {
      reads.set(usage[1], usage[2] === undefined ? 0 : parseTokenCount(usage[2]))
      writes.set(usage[1], parseTokenCount(usage[3]))
      continue
    }
    if (line.includes('"event":"passthrough.') && line.includes("evict")) {
      const reason = evictionReason(line)
      bump(evictions, reason === null ? "unparsed" : reason)
    }
  }
  const byLineage = new Map()
  let multiNew = 0
  for (const [id, kind] of lineage) {
    bump(byLineage, kind)
    if (kind === "new" && countToken(tail.get(id) ?? "", "tool_result") >= 2) multiNew++
  }
  let bigCount = 0
  let bigTokens = 0
  let readTokens = 0
  let writeTokens = 0
  for (const value of reads.values()) readTokens += value
  for (const value of writes.values()) {
    writeTokens += value
    if (value >= WRITE_THRESHOLD) {
      bigCount++
      bigTokens += value
    }
  }
  return {
    requests: lineage.size,
    by_lineage: Object.fromEntries(byLineage),
    writes_ge_100k: bigCount,
    write_tokens_ge_100k: bigTokens,
    new_lineage_after_multi_tool_results: multiNew,
    evictions: Object.fromEntries(evictions),
    cache_read_fraction: roundHalfEven(readTokens / Math.max(1, readTokens + writeTokens), 4),
  }
}

/** Positive round-half-even, matching Python round(value, digits) for these ratios. */
export function roundHalfEven(value, digits) {
  const factor = 10 ** digits
  const scaled = value * factor
  const base = Math.floor(scaled)
  const diff = scaled - base
  let rounded
  if (Math.abs(diff - 0.5) < 1e-9) rounded = base % 2 === 0 ? base : base + 1
  else rounded = diff > 0.5 ? base + 1 : base
  return rounded / factor
}

function formatPythonFloat(value) {
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")
}

function formatMap(name, entries, indent) {
  const pairs = Object.entries(entries)
  if (pairs.length === 0) return `${" ".repeat(indent)}"${name}": {}`
  const lines = [`${" ".repeat(indent)}"${name}": {`]
  for (let index = 0; index < pairs.length; index++) {
    const [key, count] = pairs[index]
    const comma = index === pairs.length - 1 ? "" : ","
    lines.push(`${" ".repeat(indent + 1)}${JSON.stringify(key)}: ${count}${comma}`)
  }
  lines.push(`${" ".repeat(indent)}}`)
  return lines.join("\n")
}

/** Python json.dumps(..., indent=1) for this report shape. */
export function formatReport(report) {
  return [
    "{",
    ` "requests": ${report.requests},`,
    `${formatMap("by_lineage", report.by_lineage, 1)},`,
    ` "writes_ge_100k": ${report.writes_ge_100k},`,
    ` "write_tokens_ge_100k": ${report.write_tokens_ge_100k},`,
    ` "new_lineage_after_multi_tool_results": ${report.new_lineage_after_multi_tool_results},`,
    `${formatMap("evictions", report.evictions, 1)},`,
    ` "cache_read_fraction": ${formatPythonFloat(report.cache_read_fraction)}`,
    "}",
  ].join("\n")
}

/**
 * @param {{ since?: string, until?: string }} [bounds]
 */
export function journalctlCommand(bounds = {}) {
  const since = bounds.since
  const until = bounds.until
  const command = ["journalctl", "--user", "-u", "meridian.service", "--no-pager", "-o", "cat"]
  if (since !== undefined) command.push("--since", since)
  if (until !== undefined) command.push("--until", until)
  return command
}

function takeValue(argv, index, flag) {
  const inline = argv[index].slice(flag.length)
  if (inline.startsWith("=")) {
    if (inline.length === 1) throw new Error(`${flag} needs a value`)
    return { value: inline.slice(1), next: index + 1 }
  }
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`)
  return { value, next: index + 2 }
}

export function parseGateArgs(argv) {
  let since
  let until
  let file
  let help = false
  for (let index = 0; index < argv.length;) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      help = true
      index++
      continue
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const taken = takeValue(argv, index, "--since")
      since = taken.value
      index = taken.next
      continue
    }
    if (arg === "--until" || arg.startsWith("--until=")) {
      const taken = takeValue(argv, index, "--until")
      until = taken.value
      index = taken.next
      continue
    }
    if (arg === "--file" || arg.startsWith("--file=")) {
      const taken = takeValue(argv, index, "--file")
      file = taken.value
      index = taken.next
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  if (!help && file === undefined && since === undefined && until === undefined) {
    throw new Error("pass --since/--until or --file=<path>")
  }
  if (file !== undefined && (since !== undefined || until !== undefined)) {
    throw new Error("pass either --file or --since/--until, not both")
  }
  return { since, until, file, help }
}

export function readJournal({ since, until, file }) {
  if (file !== undefined) return readFileSync(file, "utf8")
  const result = spawnSync("journalctl", journalctlCommand({ since, until }).slice(1), {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`journalctl exited ${result.status ?? result.signal}\n${result.stderr ?? ""}`.trim())
  }
  return result.stdout
}

function main() {
  let args
  try {
    args = parseGateArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`)
    process.exit(1)
  }
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  try {
    const text = readJournal(args)
    process.stdout.write(`${formatReport(summarizeJournal(text))}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
