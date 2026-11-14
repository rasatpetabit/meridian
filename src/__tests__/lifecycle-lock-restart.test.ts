import { afterEach, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir, hostname } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { captureProcessIncarnation, probeProcessIncarnation, processIncarnationProbeBudgetMs, type ProcessIncarnation } from "../proxy/session/processIncarnation"
import { registerLiveTranscript, SessionLifecycleLockError } from "../proxy/sessionLifecycle"

const roots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()
afterEach(async () => {
  for (const child of children) child.kill()
  await Promise.all([...children].map(child => child.exited))
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const storeDir = mkdtempSync(join(tmpdir(), "meridian-lock-restart-"))
  roots.push(storeDir)
  return { storeDir, sessionId: "after-restart", configDir: storeDir, lockWaitMs: 0 }
}

function currentOwner(): ProcessIncarnation {
  const owner = captureProcessIncarnation()
  if (!owner) throw new Error("test process incarnation unavailable")
  return owner
}

function writeOwner(storeDir: string, incarnation: ProcessIncarnation | undefined) {
  const contents = `${JSON.stringify({ pid: incarnation?.pid ?? process.pid, hostname: hostname(), token: "external-owner", incarnation })}\n${Date.now()}\n`
  writeFileSync(join(storeDir, "session-gc.json.lock"), contents, { mode: 0o600 })
  return contents
}

async function startLockOwner(storeDir: string, mode: "dead" | "live") {
  const module = pathToFileURL(resolve(import.meta.dir, "../proxy/sessionLifecycle.ts")).href
  const ready = join(storeDir, "ready")
  const child = Bun.spawn([process.execPath, "--eval", `
    import { writeFileSync } from "node:fs";
    import { withLegacyLifecycleMaintenanceLock } from ${JSON.stringify(module)};
    await withLegacyLifecycleMaintenanceLock(${JSON.stringify(storeDir)}, async () => {
      writeFileSync(${JSON.stringify(ready)}, "held");
      ${mode === "dead" ? "process.exit(0);" : "await Bun.sleep(60_000);"}
    });
  `], { stdout: "ignore", stderr: "inherit" })
  children.add(child)
  const deadline = performance.now() + processIncarnationProbeBudgetMs() + 5_000
  while (!existsSync(ready)) {
    if (child.exitCode !== null) throw new Error(`lock owner exited before ready: ${child.exitCode}`)
    if (performance.now() >= deadline) throw new Error("lock owner did not become ready")
    await Bun.sleep(5)
  }
  return child
}

it("immediately reclaims a fresh lock left by a process that exited inside the transaction", async () => {
  const target = fixture()
  const child = await startLockOwner(target.storeDir, "dead")
  expect(await child.exited).toBe(0)
  children.delete(child)
  const lock = join(target.storeDir, "session-gc.json.lock")
  const owner = JSON.parse(readFileSync(lock, "utf8").split("\n")[0]!).incarnation as ProcessIncarnation
  expect(probeProcessIncarnation(owner)).toBe("dead")
  await registerLiveTranscript(target, target)
  expect(readdirSync(target.storeDir).sort()).toEqual(["ready", "session-gc.json"])
}, 60_000)

it("respects an old lock held by a live process, then reclaims it after that process dies", async () => {
  const target = fixture()
  const child = await startLockOwner(target.storeDir, "live")
  const lock = join(target.storeDir, "session-gc.json.lock")
  const contents = readFileSync(lock, "utf8")
  // Age must never authorize taking a live owner's lock.
  const old = (Date.now() - 120_000) / 1_000
  utimesSync(lock, old, old)
  await expect(registerLiveTranscript(target, target)).rejects.toBeInstanceOf(SessionLifecycleLockError)
  expect(readFileSync(lock, "utf8")).toBe(contents)
  expect(existsSync(join(target.storeDir, "session-gc.json"))).toBe(false)
  child.kill()
  await child.exited
  children.delete(child)
  // A newly dead owner is reclaimable even if the mtime is fresh (or ahead).
  const future = (Date.now() + 120_000) / 1_000
  utimesSync(lock, future, future)
  await registerLiveTranscript(target, target)
  expect(existsSync(lock)).toBe(false)
}, 60_000)

it("reclaims a fresh lock after pid reuse by checking the process start identity", async () => {
  const target = fixture()
  const current = currentOwner()
  const previous = { ...current, startId: current.startIdKind === "darwin-ps-lstart" ? "Mon Jan 01 00:00:00 2001" : "1" }
  expect(probeProcessIncarnation(previous)).toBe("dead")
  writeOwner(target.storeDir, previous)
  await registerLiveTranscript(target, target)
  expect(readdirSync(target.storeDir)).toEqual(["session-gc.json"])
}, 30_000)

it("reclaims a fresh lock from an earlier boot on this host", async () => {
  const target = fixture()
  const current = currentOwner()
  const bootId = current.bootId === "11111111-1111-4111-8111-111111111111"
    ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111"
  writeOwner(target.storeDir, { ...current, bootId })
  await registerLiveTranscript(target, target)
  expect(readdirSync(target.storeDir)).toEqual(["session-gc.json"])
}, 30_000)

for (const kind of ["live", "foreign", "missing-identity"] as const) {
  it(`fails closed for a ${kind} owner regardless of lock age`, async () => {
    const target = fixture()
    const current = currentOwner()
    const owner = kind === "missing-identity" ? undefined : kind === "foreign"
      ? { ...current, hostId: current.hostId === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64) } : current
    const contents = writeOwner(target.storeDir, owner)
    const lock = join(target.storeDir, "session-gc.json.lock")
    const old = (Date.now() - 120_000) / 1_000
    utimesSync(lock, old, old)
    await expect(registerLiveTranscript(target, target)).rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(readFileSync(lock, "utf8")).toBe(contents)
    expect(readdirSync(target.storeDir)).toEqual(["session-gc.json.lock"])
  }, 30_000)
}
