import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  formatReport,
  journalctlCommand,
  parseTokenCount,
  summarizeJournal,
} from "../../scripts/cache-journal-gate.mjs"

const script = fileURLToPath(new URL("../../scripts/cache-journal-gate.mjs", import.meta.url))

const journal = [
  "[PROXY] req-aaa adapter=pi profile=fixture model=fake stream=true tools=2 lineage=new session=sess-aaa sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=3 msgs=user[text] → assistant[tool_use,tool_use] → user[tool_result,tool_result]",
  "[PROXY] req-aaa usage: input=2 output=8k cache_read=425k cache_write=352.7k cache=100%",
  "[PROXY] req-bbb adapter=pi profile=fixture model=fake stream=true tools=2 lineage=continuation session=sess-bbb sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=4 msgs=user[text] → user[tool_result,tool_result,tool_result]",
  "[PROXY] req-bbb usage: input=1 output=1 cache_read=1.5M cache_write=976 cache=100%",
  "[PROXY] req-ccc adapter=pi profile=fixture model=fake stream=true tools=1 lineage=new session=sess-ccc sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=2 msgs=user[tool_result]",
  "[PROXY] req-ccc usage: input=1 output=1 cache_read=0 cache_write=100k cache=0%",
  "[PROXY] req-ddd adapter=pi profile=fixture model=fake stream=true tools=1 lineage=new session=sess-ddd sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=3 msgs=user[tool_result,tool_result] → assistant[tool_use] → user[text]",
  "[PROXY] req-ddd usage: input=1 output=1 cache_read=10 cache_write=99.9k cache=0%",
  "[PROXY] req-eee adapter=pi profile=fixture model=fake stream=true tools=2 lineage=continuation session=sess-eee sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=3 msgs=user[text] → user[tool_result,tool_result]",
  "[PROXY] req-eee usage: input=1 output=1 cache_read=0 cache_write=0.1M cache=0%",
  "[PROXY] req-rewrite adapter=pi profile=fixture model=fake stream=true tools=2 lineage=new session=sess-rewrite sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=2 msgs=user[tool_result,tool_result]",
  "[PROXY] req-rewrite adapter=pi profile=fixture model=fake stream=true tools=2 lineage=continuation session=sess-rewrite sdkActive=0/1 sdkQueued=0 sessionWait=1ms msgCount=3 msgs=user[text]",
  "[PROXY] req-rewrite usage: input=1 output=1 cache_read=2 cache_write=8k cache=50%",
  "[PROXY] req-orphan usage: input=1 output=1 cache_read=1 cache_write=200k cache=0%",
  '[opencode-claude-code-provider] {"event":"passthrough.cache.evict","reason":"prefix-changed"}',
  '[opencode-claude-code-provider] {"event":"passthrough.session.evict","reason":"ttl"}',
  '[opencode-claude-code-provider] {"event":"passthrough.cache_evict"}',
  '[opencode-claude-code-provider] {"event":"passthrough.evict",',
  '[opencode-claude-code-provider] {"event":"passthrough.noncanonical_session_evicted","reason":"drain_error"}',
  '[opencode-claude-code-provider] {"event":"passthrough.keep","reason":"stay"}',
  '[other] {"event":"session.evict","reason":"nope"}',
].join("\n")

describe("parseTokenCount", () => {
  it("parses bare counts and k/M suffixes", () => {
    expect(parseTokenCount("976")).toBe(976)
    expect(parseTokenCount("8k")).toBe(8000)
    expect(parseTokenCount("352.7k")).toBe(352_700)
    expect(parseTokenCount("99.9k")).toBe(99_900)
    expect(parseTokenCount("100k")).toBe(100_000)
    expect(parseTokenCount("0.1M")).toBe(100_000)
    expect(parseTokenCount("1.5M")).toBe(1_500_000)
    expect(parseTokenCount("bogus")).toBe(0)
    expect(parseTokenCount("12kB")).toBe(0)
  })
})

describe("summarizeJournal", () => {
  const report = summarizeJournal(journal)

  it("counts requests by final lineage", () => {
    expect(report.requests).toBe(6)
    expect(report.by_lineage).toEqual({ new: 3, continuation: 3 })
  })

  it("counts cache writes at and above 100k tokens", () => {
    expect(report.writes_ge_100k).toBe(4)
    expect(report.write_tokens_ge_100k).toBe(752_700)
  })

  it("counts new-lineage requests whose tail has two or more tool results", () => {
    expect(report.new_lineage_after_multi_tool_results).toBe(1)
  })

  it("counts eviction reasons and leaves unrelated lines out", () => {
    expect(report.evictions).toEqual({
      "prefix-changed": 1,
      ttl: 1,
      "?": 1,
      unparsed: 1,
      drain_error: 1,
    })
  })

  it("reports the cache-read fraction of parsed usage", () => {
    expect(report.cache_read_fraction).toBe(0.6908)
    expect(formatReport(report)).toBe(`{
 "requests": 6,
 "by_lineage": {
  "new": 3,
  "continuation": 3
 },
 "writes_ge_100k": 4,
 "write_tokens_ge_100k": 752700,
 "new_lineage_after_multi_tool_results": 1,
 "evictions": {
  "prefix-changed": 1,
  "ttl": 1,
  "?": 1,
  "unparsed": 1,
  "drain_error": 1
 },
 "cache_read_fraction": 0.6908
}`)
  })
})

describe("journalctl command", () => {
  it("passes an explicit offset and a bare local time through unchanged", () => {
    expect(journalctlCommand({ since: "2026-11-15T00:34:58-08:00" })).toEqual([
      "journalctl", "--user", "-u", "meridian.service", "--no-pager", "-o", "cat",
      "--since", "2026-11-15T00:34:58-08:00",
    ])
    expect(journalctlCommand({
      since: "2026-11-15 00:34:58",
      until: "-4 hours",
    })).toEqual([
      "journalctl", "--user", "-u", "meridian.service", "--no-pager", "-o", "cat",
      "--since", "2026-11-15 00:34:58",
      "--until", "-4 hours",
    ])
  })
})

describe("cache-journal-gate CLI", () => {
  it("reads a saved journal from --file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-journal-gate-"))
    try {
      const file = join(dir, "journal.txt")
      writeFileSync(file, `${journal}\n`)
      const result = spawnSync(process.execPath, [script, `--file=${file}`], { encoding: "utf8" })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(summarizeJournal(journal))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("documents that a bare local time uses the process timezone", () => {
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      "A bare local time is read in the process timezone: a systemd-run unit without TZ reads it as UTC, which silently widened an earlier scheduled report to 8 hours of pre-install traffic.",
    )
    expect(result.stdout).toContain("2026-11-15T00:34:58-08:00")
  })
})
