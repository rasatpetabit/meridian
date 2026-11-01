/**
 * The opt-in prior-thinking live harness copies a credential file into a
 * private temporary root and opens listeners before its first request. Every
 * failure — credential copy, proxy import/startup, package metadata, a failed
 * run and a failed report write — must still close each listener it opened and
 * remove that root.
 *
 * The real script runs from a copied tree, so its relative `../dist` and
 * `../node_modules` reads become the fault seams. Credentials are synthetic,
 * HOME and TMPDIR are private, and the stub proxy never reaches the relay, so
 * no control can contact a cloud API, read a real credential, or touch another
 * run's root in the system temporary directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const SCRIPT = resolve(import.meta.dir, "../../scripts/e2e-prior-thinking.mjs")
const ROOT_PREFIX = "meridian-prior-thinking-"
const CHILD_TIMEOUT_MS = 20_000

// Records what the harness handed it, answers every request with 503 so the
// run fails before any model call, and records its own orderly close.
const STUB_PROXY = `
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
export async function startProxyServer() {
  writeFileSync(process.env.STUB_MARKER_DIR + '/started.json', JSON.stringify({ credentialRoot: process.env.CLAUDE_CONFIG_DIR }))
  const server = createServer((request, response) => { response.writeHead(503); response.end() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, async close() {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    writeFileSync(process.env.STUB_MARKER_DIR + '/closed', '')
  } }
}
`

let fixture: string

function harnessRoots(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter(name => name.startsWith(ROOT_PREFIX)) : []
}

function layout(options: { credentials?: boolean; proxy?: boolean; packages?: boolean }) {
  mkdirSync(join(fixture, "scripts"))
  writeFileSync(join(fixture, "scripts", "e2e-prior-thinking.mjs"), readFileSync(SCRIPT))
  for (const directory of ["creds", "tmp", "home", "markers"]) mkdirSync(join(fixture, directory))
  if (options.credentials !== false) {
    writeFileSync(join(fixture, "creds", ".credentials.json"), JSON.stringify({ synthetic: true }), { mode: 0o600 })
  }
  if (options.proxy) {
    mkdirSync(join(fixture, "dist"))
    writeFileSync(join(fixture, "dist", "server.js"), STUB_PROXY)
  }
  if (options.packages) {
    for (const name of ["claude-agent-sdk", "claude-code"]) {
      const directory = join(fixture, "node_modules", "@anthropic-ai", name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.0.0-synthetic" }))
    }
  }
}

async function runHarness(extraEnv: Record<string, string> = {}) {
  const child = spawn("node", [join(fixture, "scripts", "e2e-prior-thinking.mjs")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(fixture, "home"),
      TMPDIR: join(fixture, "tmp"),
      E2E_CLAUDE_CONFIG_DIR: join(fixture, "creds"),
      STUB_MARKER_DIR: join(fixture, "markers"),
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk })
  // A listener the harness leaves open keeps Node alive, so only an orderly
  // shutdown lets the child exit by itself before this deadline.
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(done =>
    child.on("exit", (exitCode, exitSignal) => done([exitCode, exitSignal])))
  clearTimeout(timer)
  return { code, signal, stderr, privateRoots: harnessRoots(join(fixture, "tmp")) }
}

function expectOrderlyFailure(result: Awaited<ReturnType<typeof runHarness>>) {
  expect(result.signal).toBeNull()
  expect(result.code).toBe(1)
  expect(result.privateRoots).toEqual([])
  expect(result.stderr).not.toContain("synthetic")
}

/** The credential directory the proxy was started with. Its location also
 *  proves the root was created under the private TMPDIR checked above. */
function startedCredentialRoot(): string {
  const credentialRoot = JSON.parse(readFileSync(join(fixture, "markers", "started.json"), "utf8")).credentialRoot as string
  expect(credentialRoot.startsWith(join(fixture, "tmp", ROOT_PREFIX))).toBe(true)
  return credentialRoot
}

describe("prior-thinking harness cleanup", () => {
  beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), "meridian-harness-cleanup-")) })
  afterEach(() => { rmSync(fixture, { recursive: true, force: true }) })

  it("removes the private root when the credential copy fails", async () => {
    layout({ credentials: false })
    const result = await runHarness()
    expectOrderlyFailure(result)
    expect(result.stderr).toContain("ENOENT")
  }, CHILD_TIMEOUT_MS + 5_000)

  it("closes the relay and removes the credential root when the proxy cannot be imported", async () => {
    layout({})
    const result = await runHarness()
    expectOrderlyFailure(result)
    expect(result.stderr).toContain("dist/server.js")
  }, CHILD_TIMEOUT_MS + 5_000)

  it("closes the proxy and relay and removes the credential root when package metadata is missing", async () => {
    layout({ proxy: true })
    const result = await runHarness()
    expectOrderlyFailure(result)
    expect(result.stderr).toContain("package.json")
    expect(existsSync(startedCredentialRoot())).toBe(false)
    expect(existsSync(join(fixture, "markers", "closed"))).toBe(true)
  }, CHILD_TIMEOUT_MS + 5_000)

  it("still shuts down and removes the credential root when the report write fails", async () => {
    layout({ proxy: true, packages: true })
    const reportPath = join(fixture, "missing", "report.json")
    const result = await runHarness({ E2E_REPORT_PATH: reportPath })
    expectOrderlyFailure(result)
    // Both the failed run and the failed report write are reported.
    expect(result.stderr).toContain("AssertionError")
    expect(result.stderr).toContain("report.json")
    expect(existsSync(reportPath)).toBe(false)
    expect(existsSync(startedCredentialRoot())).toBe(false)
    expect(existsSync(join(fixture, "markers", "closed"))).toBe(true)
  }, CHILD_TIMEOUT_MS + 5_000)
})
