import { describe, expect, it } from "bun:test"
import { prunePriorThinkingFile, prunePriorThinkingTranscript } from "../proxy/session/priorThinking"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const assistant = (uuid: string, id: string, content: unknown[]) => JSON.stringify({
  type: "assistant", uuid, parentUuid: "parent", message: { role: "assistant", id, content },
})
const thinking = { type: "thinking", thinking: "private", signature: "opaque" }
const text = { type: "text", text: "visible" }

describe("prior thinking transcript pruning", () => {
  it("removes older thinking but preserves every UUID, parent and API message grouping", () => {
    const rows = [assistant("a", "old", [thinking]), assistant("b", "old", [text]),
      JSON.stringify({ type: "user", uuid: "u", parentUuid: "b", message: { content: "next" } }),
      assistant("c", "new", [thinking]), assistant("d", "new", [text])]
    const result = prunePriorThinkingTranscript(rows.join("\n") + "\n")
    const parsed = result.split("\n").filter(Boolean).map(row => JSON.parse(row))
    expect(parsed[0].message.content).toEqual([])
    expect(parsed[1].message.content).toEqual([text])
    expect(parsed[3].message.content).toEqual([])
    expect(parsed[4].message.content).toEqual([text])
    expect(parsed.map(row => [row.uuid, row.parentUuid])).toEqual(rows.map(row => {
      const value = JSON.parse(row); return [value.uuid, value.parentUuid]
    }))
    expect(result.split("\n")[2]).toBe(rows[2])
  })
  it("preserves all blocks of the newest API message during an open tool loop", () => {
    const rows = [assistant("a", "old", [thinking, text]), assistant("b", "new", [thinking]),
      assistant("c", "new", [{ type: "redacted_thinking", data: "opaque" }]),
      assistant("d", "new", [{ type: "tool_use", id: "call", name: "read", input: {} }]),
      JSON.stringify({ type: "user", uuid: "denial", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "denied" }] } })]
    const result = prunePriorThinkingTranscript(rows.join("\n") + "\n").split("\n")
    expect(JSON.parse(result[0]!).message.content).toEqual([text])
    expect(result.slice(1)).toEqual([...rows.slice(1), ""])
  })
  it("retains the durable tool checkpoint even if a hidden digest follows it", () => {
    const rows = [assistant("a", "old", [thinking, text]), assistant("b", "tool", [thinking]),
      assistant("c", "tool", [{ type: "tool_use", id: "call", name: "read", input: {} }]),
      assistant("d", "digest", [thinking, text])]
    const result = prunePriorThinkingTranscript(rows.join("\n") + "\n", "c").split("\n")
    expect(JSON.parse(result[0]!).message.content).toEqual([text])
    expect(result[1]).toBe(rows[1])
    expect(result[2]).toBe(rows[2])
    expect(JSON.parse(result[3]!).message.content).toEqual([text])
    expect(() => prunePriorThinkingTranscript(rows.join("\n"), "missing")).toThrow()
  })
  it("is idempotent and never reintroduces removed thinking", () => {
    const first = prunePriorThinkingTranscript(assistant("a", "old", [thinking, text]) + "\n" + assistant("b", "new", [thinking, text]) + "\n")
    expect(prunePriorThinkingTranscript(first)).toBe(first)
    const next = prunePriorThinkingTranscript(first + assistant("c", "newer", [thinking, text]) + "\n")
    expect(JSON.parse(next.split("\n")[0]!).message.content).toEqual([text])
    expect(JSON.parse(next.split("\n")[1]!).message.content).toEqual([text])
  })
  it("atomically replaces private bytes and leaves malformed targets untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "meridian-thinking-file-"))
    const sessionId = crypto.randomUUID()
    const directory = join(root, "projects", "fixture")
    const path = join(directory, `${sessionId}.jsonl`)
    try {
      await mkdir(directory, { recursive: true })
      const original = assistant("a", "old", [thinking, text]) + "\n"
      await writeFile(path, original, { mode: 0o600 })
      await prunePriorThinkingFile({ sessionId, configDir: root })
      expect(await readFile(path, "utf8")).toBe(prunePriorThinkingTranscript(original))
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await readdir(directory)).toEqual([`${sessionId}.jsonl`])
      const malformed = original + "{broken\n"
      await writeFile(path, malformed)
      await expect(prunePriorThinkingFile({ sessionId, configDir: root })).rejects.toThrow()
      expect(await readFile(path, "utf8")).toBe(malformed)
      expect(await readdir(directory)).toEqual([`${sessionId}.jsonl`])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("fails closed on malformed transcripts instead of rewriting a partial history", () => {
    expect(() => prunePriorThinkingTranscript(assistant("a", "old", [thinking]) + "\n{broken\n")).toThrow()
    expect(() => prunePriorThinkingTranscript(JSON.stringify({ type: "assistant", message: { content: [thinking] } }) + "\n")).toThrow()
  })
})
