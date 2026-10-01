import { randomUUID } from "node:crypto"
import { open, readdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { TranscriptLocator } from "../sessionLifecycle"
import { syncDirectoryDurably } from "./durableFileSystem"

type Row = Record<string, unknown>
function object(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function assistantMessage(row: Row): Row | undefined {
  if (row.type !== "assistant" || row.isSidechain === true) return undefined
  if (!object(row.message) || typeof row.message.id !== "string" || !Array.isArray(row.message.content)) {
    throw new Error("Cannot prune malformed SDK assistant message")
  }
  return row.message
}

/** Keep the newest complete API message only for a pending tool call, not merely
 * its last JSONL fragment. Completed text answers require no thinking on resume.
 * The CLI persists thinking/text/tool blocks as separate rows sharing message.id.
 * Empty rows must remain: their UUIDs can be parents or durable checkpoints.
 * No transcript content is logged, and unchanged rows retain their exact bytes.
 */
export function prunePriorThinkingTranscript(transcript: string, checkpointUuid?: string): string {
  const lines = transcript.split("\n")
  const rows = lines.map(line => {
    if (!line.trim()) return undefined
    const row: unknown = JSON.parse(line)
    if (!object(row)) throw new Error("Cannot prune malformed SDK transcript row")
    return row
  })
  let newestId: string | undefined
  for (const row of rows) {
    const message = row && assistantMessage(row)
    if (message) newestId = message.id as string
  }
  if (checkpointUuid) {
    const checkpoint = rows.find(row => row?.uuid === checkpointUuid)
    const message = checkpoint && assistantMessage(checkpoint)
    if (!message) throw new Error("Thinking checkpoint is absent from SDK transcript")
    newestId = message.id as string
  }
  const pendingToolCall = rows.some(row => {
    const message = row && assistantMessage(row)
    return message !== undefined && message.id === newestId && (message.content as unknown[]).some(block => object(block) && block.type === "tool_use")
  })
  return lines.map((line, index) => {
    const row = rows[index]
    const message = row && assistantMessage(row)
    if (!row || !message || (pendingToolCall && message.id === newestId)) return line
    const content = message.content as unknown[]
    const kept = content.filter(block => !object(block) || !["thinking", "redacted_thinking"].includes(String(block.type)))
    return kept.length === content.length ? line : JSON.stringify({ ...row, message: { ...message, content: kept } })
  }).join("\n")
}

/** Find the exact owned session across CLI project directory encodings. Avoid
 * duplicating its cwd encoding/hash algorithm (which changes across releases).
 */
async function transcriptPath(locator: TranscriptLocator): Promise<string> {
  const projects = join(locator.configDir, "projects")
  const matches: string[] = []
  for (const entry of await readdir(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = join(projects, entry.name)
    let files: string[]
    try {
      files = await readdir(directory)
    } catch (error) {
      // A sibling project's last session can be collected while we search.
      // Only disappearance is benign; permission and I/O errors fail closed.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
    if (files.includes(`${locator.sessionId}.jsonl`)) {
      matches.push(join(directory, `${locator.sessionId}.jsonl`))
    }
  }
  if (matches.length !== 1) throw new Error("Cannot uniquely locate owned SDK transcript for thinking pruning")
  return matches[0]!
}

/** Caller holds the exclusive lifecycle writer lease and has joined the SDK
 * child. Only the new fork is rewritten; its immutable source remains rollback.
 * A crash leaves either the original or the fully fsynced pruned transcript.
 */
export async function prunePriorThinkingFile(locator: TranscriptLocator, checkpointUuid?: string): Promise<void> {
  const path = await transcriptPath(locator)
  const source = await open(path, "r")
  let original: string
  let mode: number
  try {
    const stat = await source.stat()
    if (!stat.isFile()) throw new Error("SDK transcript is not a regular file")
    mode = stat.mode & 0o777
    original = await source.readFile("utf8")
  } finally {
    await source.close()
  }
  const pruned = prunePriorThinkingTranscript(original, checkpointUuid)
  if (pruned === original) return
  const temporary = join(dirname(path), `.thinking-${randomUUID()}.tmp`)
  try {
    const target = await open(temporary, "wx", mode)
    try {
      await target.writeFile(pruned, "utf8")
      await target.sync()
    } finally {
      await target.close()
    }
    await rename(temporary, path)
    await syncDirectoryDurably(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}
