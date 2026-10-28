#!/usr/bin/env bun
// Offline only: real Meridian preparation -> Agent SDK -> CLI -> local mock.
// Synthetic content only. No model or Hindsight service calls.
// Run with --scratch=<existing private disk directory>. Optional actual recall
// callback/fold characterization: --hindsight-root=<repo> --fold-file=<file>.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { spyOn } from "bun:test"
import * as sdk from "@anthropic-ai/claude-agent-sdk"
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
// Cache-control annotations select checkpoints, not input content. No thinking,
// reminders, whitespace, role, or signature is removed by this comparison.
const key = value => JSON.stringify(value, (k, v) => k === "cache_control" ? undefined : v)
const content = m => Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]
function cacheBlocks(body) {
  return [...body.tools.map(t => ({ key: key(t), marked: !!t.cache_control, location: "tools" })),
    ...body.system.map((s, i) => ({ key: key(s), marked: !!s.cache_control, location: `system[${i}]` })),
    ...body.messages.flatMap((m, i) => content(m).map((b, j) => ({ key: key([m.role, b]), marked: !!b.cache_control, location: `messages[${i}].content[${j}]` })))]
}
assert(arg("scratch"), "--scratch is required (no production paths)")
const root = mkdtempSync(join(arg("scratch"), "synthetic-prefix-"))
const stream = process.argv.includes("--stream")
const require = createRequire(import.meta.url)
console.log(JSON.stringify({ sdk: require("@anthropic-ai/claude-agent-sdk/package.json").version, cli: require("@anthropic-ai/claude-code/package.json").version, stream }))
for (const k of Object.keys(process.env)) if (k.startsWith("MERIDIAN_") || k.startsWith("CLAUDE_PROXY_") || k.startsWith("ANTHROPIC_") || k === "CLAUDE_CODE_OAUTH_TOKEN") delete process.env[k]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_WORKDIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"), MERIDIAN_PASSTHROUGH: "1", MERIDIAN_TELEMETRY_PERSIST: "0",
  HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
let phase = "tool"
let current
const requests = []
const queries = []
const errors = []
const thought = "Synthetic pending-tool reasoning retained in the next provider input."
const recallA = "SYNTHETIC_RECALL_ORIGINAL"
const recallB = "SYNTHETIC_RECALL_FRESH"
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith("/messages")) return Response.json({ input_tokens: 100 })
  const body = await req.json()
  // Ignore SDK warmup probes, not conversation requests.
  if (!body.tools?.some(t => t.name.endsWith("read_fixture"))) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  requests.push({ phase, body })
  const tool = body.tools.find(t => t.name.endsWith("read_fixture"))
  const blocks = phase === "tool" ? [ { type: "thinking", thinking: thought, signature: "synthetic-signature" },
    { type: "tool_use", id: "toolu_prefix", name: tool.name, input: {} } ] : [{ type: "text", text: "Synthetic answer" }]
  const events = [{ type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } }]
  for (const [index, b] of blocks.entries()) {
    events.push({ type: "content_block_start", index, content_block: b.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : b.type === "text" ? { type: "text", text: "" } : { ...b, input: {} } })
    if (b.type === "thinking") events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } }, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } })
    else events.push({ type: "content_block_delta", index, delta: b.type === "text" ? { type: "text_delta", text: b.text } : { type: "input_json_delta", partial_json: "{}" } })
    events.push({ type: "content_block_stop", index })
  }
  events.push({ type: "message_delta", delta: { stop_reason: phase === "tool" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }, { type: "message_stop" })
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
} })
const realQuery = sdk.query
const observer = spyOn(sdk, "query").mockImplementation(input => {
  current = input.options
  queries.push({ phase, resume: current.resume, sessionId: current.sessionId, resumeSessionAt: current.resumeSessionAt })
  return realQuery(input)
})
const sourceRoot = arg("source-root") ?? fileURLToPath(new URL("../", import.meta.url))
const { createProxyServer, clearSessionCache } = await import(join(sourceRoot, "src/proxy/server.ts"))
const { readSessionStoreSnapshot, storeSharedSession } = await import(join(sourceRoot, "src/proxy/sessionStore.ts"))
const profile = { id: "offline", type: "api", apiKey: "sk-offline-synthetic", baseUrl: `http://127.0.0.1:${upstream.port}` }
const tool = { name: "read_fixture", description: "Synthetic read", input_schema: { type: "object", properties: {} } }
let policy, fold
if (arg("hindsight-root") || arg("fold-file")) {
  assert(arg("hindsight-root") && arg("fold-file"), "Both recall characterization inputs required")
  const { createRecallTurnPolicy } = await import(join(arg("hindsight-root"), "extensions/lifecycle/memory-lifecycle-recall.ts"))
  const { DEFAULT_CONFIG } = await import(join(arg("hindsight-root"), "extensions/config/config.ts"))
  fold = (await import(arg("fold-file"))).foldTransients
  let recalled = 0
  const config = { ...DEFAULT_CONFIG, recall: { ...DEFAULT_CONFIG.recall, injectionPosition: "append", storeLastRecall: false },
    banks: { ...DEFAULT_CONFIG.banks, project: { ...DEFAULT_CONFIG.banks.project, bankId: "synthetic-bank", enabled: true }, user: { ...DEFAULT_CONFIG.banks.user, enabled: false } } }
  policy = createRecallTurnPolicy({ getConfig: () => config, getClient: () => ({ recall: async () => ({ results: [{ text: ++recalled === 1 ? recallA : recallB }] }), retain: async () => { throw Error("retain forbidden") }, reflect: async () => { throw Error("reflect forbidden") } }), setMemoryStatus: () => {}, notify: () => {} })
}
async function outgoing(messages) {
  if (!policy) return messages
  // Pi's context hook sees toolResult, not an Anthropic role:user tool_result.
  // Its documented append callback therefore skips the tool continuation.
  const piMessages = messages.map(m => Array.isArray(m.content) && m.role === "user" && m.content[0]?.type === "tool_result"
    ? { role: "toolResult", toolCallId: m.content[0].tool_use_id, content: [{ type: "text", text: m.content[0].content }] } : m)
  const patch = await policy.recall({ messages: piMessages }, { cwd: root, ui: { setStatus: () => {}, notify: () => {} } })
  const result = fold(patch?.messages ?? piMessages, piMessages)
  assert(!result.mismatch)
  return result.messages.map(m => m.role === "toolResult" ? { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content[0].text }] } : m)
}
async function send(app, messages) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi", "x-session-affinity": "synthetic-prefix" },
    body: JSON.stringify({ model: "claude-fable-5-1", stream, max_tokens: 2048, thinking: { type: "adaptive" }, tools: [tool], messages: await outgoing(messages) }) }))
  const text = await response.text()
  assert.equal(response.status, 200, text)
  if (!stream) return JSON.parse(text).content
  const blocks = []
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const event = JSON.parse(line.slice(6))
    assert.notEqual(event.type, "error", line)
    if (event.type === "content_block_start") blocks[event.index] = { ...event.content_block }
    if (event.type !== "content_block_delta") continue
    const block = blocks[event.index], delta = event.delta
    if (delta.type === "thinking_delta") block.thinking = (block.thinking ?? "") + delta.thinking
    if (delta.type === "signature_delta") block.signature = (block.signature ?? "") + delta.signature
    if (delta.type === "text_delta") block.text = (block.text ?? "") + delta.text
    if (delta.type === "input_json_delta") block.partial = (block.partial ?? "") + delta.partial_json
  }
  for (const block of blocks) if (block.type === "tool_use") { block.input = JSON.parse(block.partial || "{}"); delete block.partial }
  assert(blocks.length)
  return blocks
}
try {
  // Both arms start from the identical CLI transcript, written with pruning OFF.
  process.env.MERIDIAN_DROP_PRIOR_THINKING = "0"
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: [profile], defaultProfile: "offline" })
  const first = [{ role: "user", content: "Use the synthetic read tool", timestamp: 1 }]
  const blocks = await send(app, first)
  assert(blocks.some(b => b.type === "tool_use"))
  const starting = readFileSync(join(process.env.CLAUDE_CONFIG_DIR, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${current.sessionId}.jsonl`), "utf8")
  writeFileSync(join(root, "starting.jsonl"), starting, { mode: 0o600 })
  const seedId = current.sessionId
  const seedPath = join(process.env.CLAUDE_CONFIG_DIR, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${seedId}.jsonl`)
  const seedMappings = readSessionStoreSnapshot()
  assert(Object.keys(seedMappings).length)
  const resultTurn = [...first, { role: "assistant", content: blocks }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_prefix", content: "SYNTHETIC_RESULT" }] }]
  const resultBodies = []
  const afterBodies = []
  // Restore only the synthetic cache mapping. Both arms resume exactly the same
  // immutable transcript bytes and checkpoint, not separately generated seeds.
  for (const enabled of ["1", "0"]) {
    clearSessionCache()
    for (const [key, s] of Object.entries(seedMappings)) assert(storeSharedSession(key, s.claudeSessionId, s.messageCount, s.lineageHash, s.messageHashes,
      s.sdkMessageUuids, s.contextUsage, s.messageBlockHashes, s.passthroughToolCallAssistantUuid, s.passthroughToolCallIds, s.currentTranscript, s.previousTranscript))
    assert.equal(readFileSync(seedPath, "utf8"), starting)
    process.env.MERIDIAN_DROP_PRIOR_THINKING = enabled
    phase = `result-${enabled}`
    const answer = await send(app, resultTurn)
    const before = requests.at(-1).body
    assert.equal(queries.at(-1).resume, seedId, "Both arms must resume the identical starting transcript")
    phase = `next-${enabled}`
    await send(app, [...resultTurn, { role: "assistant", content: answer }, { role: "user", content: "New question for fresh memory", timestamp: 2 }])
    assert(queries.at(-1).resume, "Must exercise resumed next turn")
    const after = requests.at(-1).body
    // Reviewer slice 1 of 2 (per-arm): already-sent thinking, prefix through
    // the previous checkpoint, and historical recall position. Complete
    // before->after equality is deliberately NOT asserted; the documented
    // nonstream SDK tail nudge after the checkpoint is out of scope.
    const old = before.messages.find(m => JSON.stringify(m).includes(thought))
    assert(old, "The original thought must actually have been sent as INPUT")
    const n = before.messages.indexOf(old)
    const same = JSON.stringify(after.messages[n]) === JSON.stringify(old)
    assert.equal(key(before.tools), key(after.tools), "Synthetic tools changed")
    assert.equal(key(before.system), key(after.system), "Synthetic system changed")
    const oldBlocks = cacheBlocks(before), newBlocks = cacheBlocks(after)
    const checkpoint = oldBlocks.findLastIndex(b => b.marked)
    assert(checkpoint >= 0)
    const firstDiff = oldBlocks.findIndex((b, i) => b.key !== newBlocks[i]?.key)
    const stableCheckpoint = firstDiff < 0 || firstDiff > checkpoint
    const newCheckpoint = newBlocks.findLastIndex(b => b.marked)
    const lookbackDistance = newCheckpoint - checkpoint
    const addressable = stableCheckpoint && lookbackDistance >= 0 && lookbackDistance < 20
    const seenA = JSON.stringify(after.messages).includes(recallA)
    const seenB = JSON.stringify(after.messages).includes(recallB)
    resultBodies.push(before.messages)
    afterBodies.push(after.messages)
    console.log(JSON.stringify({ enabled, historicalThinkingStable: same, firstDifferentMessage: same ? null : n, firstDifferentCacheBlock: firstDiff < 0 ? null : oldBlocks[firstDiff].location, priorCheckpoint: oldBlocks[checkpoint].location, stableCheckpoint, lookbackDistance, addressable, historicalRecall: policy ? seenA : "not-tested", freshRecall: policy ? seenB : "not-tested", retainedThinkingBytes: Buffer.byteLength(thought) }))
    // Distinct defects: content mutation reports the exact first differing
    // block; lookback-range failure reports the marker distance instead.
    if (!same || !stableCheckpoint) errors.push(`prune=${enabled}: prefix content mutated at ${firstDiff < 0 ? `messages[${n}]` : oldBlocks[firstDiff].location}`)
    if (stableCheckpoint && !addressable) errors.push(`prune=${enabled}: prior checkpoint outside 20-block lookback (distance ${lookbackDistance})`)
    if (policy) {
      const recallN = before.messages.findIndex(m => JSON.stringify(m).includes(recallA))
      assert(recallN >= 0, "Historical recall must remain in SDK provider history on tool continuation")
      assert.equal(JSON.stringify(after.messages[recallN]), JSON.stringify(before.messages[recallN]), "Historical recall message mutated across tool continuation")
      assert(seenA, "Historical recall disappeared at provider")
      assert(seenB, "Fresh recall unavailable at provider")
      assert.equal(JSON.stringify(after.messages).split(recallA).length - 1, 1, "Historical recall duplicated")
      assert.equal(JSON.stringify(after.messages).split(recallB).length - 1, 1, "Fresh recall duplicated")
      assert(JSON.stringify(after.messages.at(-1)).includes(recallB), "Fresh recall is not at the unsent tail")
      assert(!JSON.stringify(first).includes("hindsight-memory"), "Recall contaminated Pi transcript")
    }
  }
  // Reviewer slice 2 of 2 (cross-arm): from the identical seed state, both
  // arms' starting and final provider messages must match byte-for-byte
  // (deterministic fixture, no normalization); a real mismatch stops here.
  assert.deepEqual(resultBodies[0], resultBodies[1], "ON/OFF must start with identical provider messages")
  assert.deepEqual(afterBodies[0], afterBodies[1], "ON/OFF arms ended with different provider messages")
  assert.equal(errors.length, 0, errors.join("; "))
} finally {
  writeFileSync(join(root, "requests.json"), JSON.stringify(requests), { mode: 0o600 })
  writeFileSync(join(root, "queries.json"), JSON.stringify(queries), { mode: 0o600 })
  observer.mockRestore()
  upstream.stop(true)
  console.log(`Synthetic evidence: ${root}`)
}
process.exit(0)
