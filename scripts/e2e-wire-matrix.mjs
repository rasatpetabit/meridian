#!/usr/bin/env bun
// Real-CLI offline wire matrix. Each row is harness arguments only;
// this runner supplies --claude and a per-row --wire capture.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptDir)
const harness = join(scriptDir, "e2e-offline-fresh-checkpoint.mjs")
const ROW_TIMEOUT_MS = 300_000

/** Harness flags for every real-CLI offline matrix row, in capture order. */
export const ROWS = [
  // Each keepalive row includes its own no-beat control, through the real CLI.
  { label: "keepalive-text", args: ["--keepalive=text"] },
  { label: "keepalive-single", args: ["--keepalive=single"] },
  { label: "keepalive-parallel2", args: ["--keepalive=parallel2"] },
  { label: "keepalive-parallel3", args: ["--keepalive=parallel3", "--keepalive-prove-red"] },
  { label: "keepalive-checkpoint", args: ["--keepalive=checkpoint"] },
  { label: "keepalive-mixed-bare", args: ["--keepalive=mixed", "--mixed", "--bare-call=2"] },
  { label: "keepalive-thinking", args: ["--keepalive=thinking"] },
  { label: "keepalive-5m-skip", args: ["--keepalive=5m", "--keepalive-prove-red"] },
  { label: "keepalive-wide-skip", args: ["--keepalive=wide", "--keepalive-prove-red"] },
  { label: "shapes-error-first-2", args: ["--captured", "--calls=2", "--result-kind=error-first"] },
  { label: "shapes-error-first-2-follow", args: ["--captured", "--calls=2", "--result-kind=error-first", "--follow-on"] },
  { label: "shapes-error-first-3", args: ["--captured", "--calls=3", "--result-kind=error-first"] },
  { label: "shapes-error-first-3-follow", args: ["--captured", "--calls=3", "--result-kind=error-first", "--follow-on", "--thinking"] },
  { label: "shapes-error-later-2", args: ["--captured", "--calls=2", "--result-kind=error-later"] },
  { label: "shapes-error-later-2-follow", args: ["--captured", "--calls=2", "--result-kind=error-later", "--follow-on"] },
  { label: "shapes-error-later-3", args: ["--captured", "--calls=3", "--result-kind=error-later"] },
  { label: "shapes-error-later-3-follow", args: ["--captured", "--calls=3", "--result-kind=error-later", "--follow-on", "--thinking"] },
  { label: "shapes-image-first-2", args: ["--captured", "--calls=2", "--result-kind=image-first"] },
  { label: "shapes-image-first-2-follow", args: ["--captured", "--calls=2", "--result-kind=image-first", "--follow-on"] },
  { label: "shapes-image-first-3", args: ["--captured", "--calls=3", "--result-kind=image-first"] },
  { label: "shapes-image-first-3-follow", args: ["--captured", "--calls=3", "--result-kind=image-first", "--follow-on", "--thinking"] },
  { label: "shapes-image-later-2", args: ["--captured", "--calls=2", "--result-kind=image-later"] },
  { label: "shapes-image-later-2-follow", args: ["--captured", "--calls=2", "--result-kind=image-later", "--follow-on"] },
  { label: "shapes-image-later-3", args: ["--captured", "--calls=3", "--result-kind=image-later"] },
  { label: "shapes-image-later-3-follow", args: ["--captured", "--calls=3", "--result-kind=image-later", "--follow-on", "--thinking"] },
  { label: "shapes-reversed-2", args: ["--captured", "--calls=2", "--result-kind=reversed"] },
  { label: "shapes-reversed-2-follow", args: ["--captured", "--calls=2", "--result-kind=reversed", "--follow-on"] },
  { label: "shapes-reversed-3", args: ["--captured", "--calls=3", "--result-kind=reversed"] },
  { label: "shapes-reversed-3-follow", args: ["--captured", "--calls=3", "--result-kind=reversed", "--follow-on", "--thinking"] },
  { label: "shapes-missing-later-2", args: ["--captured", "--calls=2", "--result-kind=missing-later"] },
  { label: "shapes-missing-later-2-follow", args: ["--captured", "--calls=2", "--result-kind=missing-later", "--follow-on"] },
  { label: "shapes-original-01", args: [] },
  { label: "shapes-original-02", args: ["--thinking", "--calls=1"] },
  { label: "shapes-original-03", args: ["--thinking", "--calls=3"] },
  { label: "shapes-original-04", args: ["--mixed", "--calls=2"] },
  { label: "shapes-original-05", args: ["--mixed", "--calls=2", "--input-validation"] },
  { label: "shapes-original-06", args: ["--deferred", "--calls=2"] },
  { label: "shapes-original-07", args: ["--deferred", "--calls=2", "--mixed", "--captured-last", "--non-stream"] },
  { label: "shapes-original-08", args: ["--deferred", "--calls=1"] },
  { label: "shapes-original-09", args: ["--deferred", "--calls=1", "--non-stream"] },
  { label: "shapes-original-10", args: ["--deferred", "--calls=1", "--input-validation"] },
  { label: "shapes-original-11", args: ["--captured", "--calls=1"] },
  { label: "shapes-original-12", args: ["--captured", "--calls=2"] },
  { label: "shapes-original-13", args: ["--captured", "--calls=3"] },
  { label: "shapes-original-14", args: ["--captured", "--calls=3", "--sse-delay-ms=25", "--distinct-tools"] },
  { label: "shapes-original-15", args: ["--unstreamed", "--deferred", "--captured", "--calls=1"] },
  { label: "shapes-original-16", args: ["--unstreamed", "--deferred", "--captured", "--calls=2"] },
  { label: "shapes-original-17", args: ["--unstreamed", "--deferred", "--captured", "--calls=3"] },
  { label: "shapes-original-18", args: ["--unstreamed", "--deferred", "--mixed", "--calls=2"] },
  { label: "shapes-original-19", args: ["--unstreamed", "--deferred", "--mixed", "--calls=2", "--captured-last"] },
  { label: "shapes-original-20", args: ["--captured", "--calls=2", "--non-stream"] },
  { label: "shapes-original-21", args: ["--captured", "--calls=3", "--non-stream"] },
  { label: "shapes-original-22", args: ["--captured", "--calls=2", "--deferred"] },
  { label: "shapes-original-23", args: ["--captured", "--calls=3", "--thinking", "--follow-on"] },
  { label: "shapes-original-24", args: ["--captured", "--calls=2", "--follow-on"] },
  // JSON normal completion forwards every refused call; deferred tools allow the hidden turn to drain.
  { label: "json-deferred-refused-2", args: ["--deferred", "--non-stream", "--calls=2"] },
  { label: "json-deferred-refused-3", args: ["--deferred", "--non-stream", "--calls=3"] },
  // Mixed batches whose uncaptured calls are name-dispatch refusals resume with hybrid results.
  { label: "mixed-bare-2-1-follow", args: ["--mixed", "--calls=2", "--bare-call=1", "--follow-on"] },
  { label: "mixed-bare-2-2-follow", args: ["--mixed", "--calls=2", "--bare-call=2", "--follow-on"] },
  { label: "mixed-bare-3-1-follow", args: ["--mixed", "--calls=3", "--bare-call=1", "--follow-on"] },
  { label: "mixed-bare-3-2-follow-thinking", args: ["--mixed", "--calls=3", "--bare-call=2", "--follow-on", "--thinking"] },
  { label: "mixed-bare-3-3-follow", args: ["--mixed", "--calls=3", "--bare-call=3", "--follow-on"] },
  { label: "mixed-two-bare-later-3-follow", args: ["--mixed", "--calls=3", "--follow-on"] },
  { label: "mixed-two-bare-first-3-follow", args: ["--mixed", "--calls=3", "--captured-last", "--follow-on"] },
  // Mixed controls that must keep fresh replay.
  { label: "mixed-deferred-control", args: ["--mixed", "--calls=2", "--deferred"] },
  { label: "mixed-non-stream-control", args: ["--mixed", "--calls=2", "--captured-last", "--non-stream"] },
]

const HELP = `Usage: bun scripts/e2e-wire-matrix.mjs --claude=<CLI path>

Run every committed real-CLI offline wire-matrix row through
scripts/e2e-offline-fresh-checkpoint.mjs. MERIDIAN_E2E_SCRATCH is required.
Wire captures go to a fresh directory under it and are removed after a passing run.
The checkpoint harness sets TMPDIR to its scratch directory, so
MERIDIAN_E2E_SCRATCH must be ext4, xfs, btrfs, or tmpfs — not virtiofs.
`

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function assertRowList() {
  const forbidden = /^(?:--claude|--source-root|--wire)(?:=|$)/
  const labels = new Set()
  if (ROWS.length !== 66) fail(`wire matrix has ${ROWS.length} rows, expected 66`)
  for (const row of ROWS) {
    if (labels.has(row.label)) fail(`duplicate wire-matrix row ${row.label}`)
    labels.add(row.label)
    for (const arg of row.args) {
      if (forbidden.test(arg) || arg.startsWith("/")) fail(`row ${row.label} contains a dropped argument: ${arg}`)
    }
  }
}

function summaryCalls(stdout) {
  const found = []
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{") || !trimmed.includes('"liveModelCalls"')) continue
    let value
    try {
      value = JSON.parse(trimmed)
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, calls: [] }
      throw error
    }
    if (value && typeof value === "object" && "liveModelCalls" in value) found.push(value.liveModelCalls)
  }
  return { ok: found.length > 0 && found.every(call => call === 0), calls: found }
}

function failureHint(stdout, stderr) {
  const lines = `${stderr}\n${stdout}`.split("\n").map(line => line.trim()).filter(Boolean)
  const interesting = lines.find(line => /unsupported bookkeeping|AssertionError|Error/.test(line)) ?? lines.at(-1) ?? ""
  return interesting.replaceAll(/\s+/g, " ").slice(0, 200)
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP)
    return
  }
  if (argv.length !== 1 || !argv[0].startsWith("--claude=") || argv[0].slice("--claude=".length) === "") {
    fail(`pass --claude=<CLI path>\n${HELP}`)
  }
  const scratch = process.env.MERIDIAN_E2E_SCRATCH
  if (!scratch) fail(`MERIDIAN_E2E_SCRATCH is required\n${HELP}`)
  assertRowList()
  const claude = argv[0]
  mkdirSync(scratch, { recursive: true })
  const wireDir = mkdtempSync(join(scratch, "wire-matrix-"))
  let failed = 0
  let finished = false
  try {
    for (const row of ROWS) {
      const wire = join(wireDir, `${row.label}-wire.json`)
      const result = spawnSync(process.execPath, [harness, claude, ...row.args, `--wire=${wire}`], {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
        timeout: ROW_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      })
      const calls = summaryCalls(result.stdout ?? "")
      const ok = result.status === 0 && calls.ok
      if (!ok) failed++
      if (ok && row.label.startsWith("keepalive-")) {
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("PASS ") || line.startsWith('{"shape":')) writeSync(1, `${row.label}: ${line}\n`)
        }
      }
      const detail = ok
        ? ""
        : ` exit=${result.status ?? result.signal ?? "none"} liveModelCalls=${calls.calls.length ? calls.calls.join(",") : "missing"} ${failureHint(result.stdout ?? "", result.stderr ?? "")}`
      writeSync(1, `${ok ? "PASS" : "FAIL"} ${row.label}${detail}\n`)
    }
    finished = true
  } finally {
    if (finished && failed === 0) rmSync(wireDir, { recursive: true, force: true })
  }
  const passed = ROWS.length - failed
  writeSync(1, `${failed === 0 ? "pass" : "fail"} ${passed}/${ROWS.length}\n`)
  if (failed !== 0) process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
