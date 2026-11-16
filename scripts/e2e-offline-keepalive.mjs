// Invoked by e2e-offline-fresh-checkpoint.mjs --keepalive=<shape>.
// Real HTTP → gated SDK → native CLI; only clock and synthetic account identity
// are injected. API credentials remain dummy and the upstream is loopback only.
import assert from "node:assert/strict"
import { mock } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export async function runKeepalive() {
  const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  const shape = arg("keepalive")
  assert(["text", "single", "parallel2", "parallel3", "checkpoint", "checkpoint1", "mixed", "thinking", "5m", "wide"].includes(shape), "unknown keepalive shape")
  assert(arg("claude"), "pass --claude=/absolute/path/to/claude")
  const cli = resolve(arg("claude"))
  const proveRed = process.argv.includes("--keepalive-prove-red")
  const red = (label, check, value, perturb) => {
    if (!proveRed) return
    const mutant = structuredClone(value)
    perturb(mutant)
    assert.throws(() => check(mutant), { code: "ERR_ASSERTION" }, `${label} assertion did not reject corrupted evidence`)
    console.log(`PASS RED demonstration: ${label} rejects perturbed recorded-wire witness (restored)`)
  }
  // Exactly the existing matrix's R1 equivalence: cache-control annotations
  // move per request and the CLI may encode a system content string as one
  // text block. Never normalize any actual content bytes.
  const contentPrefix = value => Array.isArray(value) ? value.map(contentPrefix)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "cache_control").map(([key, item]) => [key,
        key === "content" && typeof item === "string" ? [{ type: "text", text: item }] : contentPrefix(item)])) : value
  const assertPrefix = (before, after) => {
    assert.equal(JSON.stringify(after.system), JSON.stringify(before.system), "beat system must be byte-identical")
    assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools), "beat tools must be byte-identical")
    assert.equal(JSON.stringify(contentPrefix(after.messages.slice(0, before.messages.length))), JSON.stringify(contentPrefix(before.messages)), "beat messages must begin with last real request content unchanged")
  }
  const assertAbort = witness => {
    assert.equal(witness.inFlight, 0, "beat must abort at first response, before output")
    assert(witness.cancelled && !witness.tailSent, "beat must cancel immediately after message_start")
  }
  const assertSkip = beats => assert.equal(beats.length, 0, "ineligible session must skip without sending")
  const assertNoLeak = request => {
    assert(!JSON.stringify(request).includes(keepalive.CACHE_KEEPALIVE_PROMPT), "beat prompt must not leak")
    assert(!JSON.stringify(request).includes("KEEPALIVE_PARTIAL_OUTPUT_SENTINEL"), "beat output must not leak")
  }
  // SDK-generated user/session identity is not prompt content. No other field
  // is excluded: every non-metadata byte, including cache markers, must match.
  const modelInput = ({ metadata, ...body }) => body
  const assertControl = (control, actual) => assert.equal(JSON.stringify(modelInput(actual)), JSON.stringify(control), "follow-on must be byte-identical to no-beat control (excluding session metadata only)")
  const assertResults = (request, calls, result) => {
    for (const call of calls) assert.equal(JSON.stringify(request.messages).split(result(call)).length - 1, 1, "real tool result exactly once: " + call.id)
  }
  const sourceRoot = resolve(arg("source-root") ?? new URL("..", import.meta.url).pathname)
  const scratch = process.env.MERIDIAN_E2E_SCRATCH
  assert(scratch, "MERIDIAN_E2E_SCRATCH required (local filesystem)")
  const root = mkdtempSync(join(scratch, "keepalive-"))
  const load = path => import(join(sourceRoot, path))
  for (const key of Object.keys(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|MERIDIAN_)/.test(key)) delete process.env[key]
  }
  Object.assign(process.env, {
    HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, "claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"),
    MERIDIAN_WORKDIR: root, MERIDIAN_CLAUDE_PATH: cli, MERIDIAN_PASSTHROUGH: "1",
    MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_CACHE_KEEPALIVE: "1",
  })
  // Keep production scheduling and registration intact. The fixture's API
  // environment is used unchanged, but its account type is a subscription so
  // the real server can register the recipe and apply all eligibility checks.
  const profiles = await load("src/proxy/profiles.ts")
  const resolveProfile = profiles.resolveProfile
  mock.module(join(sourceRoot, "src/proxy/profiles.ts"), () => ({ ...profiles,
    resolveProfile: (...args) => {
      const profile = resolveProfile(...args)
      return profile.id === "offline" ? { ...profile, type: "claude-max" } : profile
    },
  }))
  const keepalive = await load("src/proxy/cacheKeepalive.ts")
  const redMode = arg("keepalive-red")
  assert(!redMode || redMode === "tools", "only --keepalive-red=tools is supported")
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  const Scheduler = keepalive.CacheKeepaliveScheduler
  let clock = Date.now()
  let scheduler
  mock.module(join(sourceRoot, "src/proxy/cacheKeepalive.ts"), () => ({ ...keepalive,
    CacheKeepaliveScheduler: class extends Scheduler {
      constructor(options) {
        super({ ...options, now: () => clock,
          beat: (recipe, ...args) => {
            if (redMode === "tools") return options.beat({ ...recipe,
              createMcpServers: () => ({ ...recipe.createMcpServers(), negative: sdk.createSdkMcpServer({ name: "negative", version: "1.0.0",
                tools: [sdk.tool("extra", "Negative control only", {}, async () => ({ content: [] }))],
              }) }),
            }, ...args)
            return options.beat(recipe, ...args)
          },
        })
        scheduler = this
      }
    },
  }))
  const wire = []
  let phase = "real"
  let arm = "control"
  let turn = 0
  let beatCancelled = false
  let beatTailSent = false
  const count = shape === "wide" ? 9 : ["parallel3", "mixed"].includes(shape) ? 3
    : ["parallel2", "checkpoint"].includes(shape) ? 2 : shape === "text" ? 0 : 1
  if (shape === "mixed") {
    assert(process.argv.includes("--mixed"), "mixed keepalive row requires --mixed")
    assert.equal(arg("bare-call"), "2", "mixed fixture uses --bare-call=2")
  }
  const thinking = shape === "thinking"
  const calls = Array.from({ length: count }, (_, index) => ({ type: "tool_use", id: `toolu_keepalive_${index}`,
    name: "read", input: { path: `fixture-${index}` } }))
  const result = call => `REAL_CLIENT_RESULT[${call.id}]`
  const tierUsage = beat => ({ input_tokens: 10, output_tokens: 0,
    cache_read_input_tokens: beat ? 20000 : 0, cache_creation_input_tokens: beat ? 0 : 20000,
    cache_creation: { ephemeral_1h_input_tokens: !beat && shape !== "5m" ? 20000 : 0,
      ephemeral_5m_input_tokens: !beat && shape === "5m" ? 20000 : 0 } })
  const frame = (event, data) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/v1/messages")
      const body = await request.json()
      const beat = phase === "beat"
      wire.push({ arm, phase, body })
      const blocks = beat ? [{ type: "text", text: "KEEPALIVE_PARTIAL_OUTPUT_SENTINEL" }]
        : turn === 1 && count ? [
          ...(thinking ? [{ type: "thinking", thinking: "offline thought", signature: "offline-signature" }] : []),
          ...calls.map((call, index) => ({ ...call, name: shape === "mixed" && index === 1 ? "read" : "mcp__oc__read" })),
        ] : [{ type: "text", text: turn === 1 ? "initial complete" : turn === 2 ? "results complete" : "follow complete" }]
      const events = [
        ["message_start", { type: "message_start", message: { id: `msg_keepalive_${turn}`, type: "message", role: "assistant",
          model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: tierUsage(beat) } }],
        ...blocks.flatMap((block, index) => [
          ["content_block_start", { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} }
            : block.type === "thinking" ? { ...block, thinking: "", signature: "" } : { ...block, text: "" } }],
          ...(block.type === "thinking" ? [
            ["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }],
            ["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }],
          ] : [["content_block_delta", { type: "content_block_delta", index, delta: block.type === "tool_use"
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } }]]),
          ["content_block_stop", { type: "content_block_stop", index }],
        ]),
        ["message_delta", { type: "message_delta", delta: { stop_reason: turn === 1 && count && !beat ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }],
        ["message_stop", { type: "message_stop" }],
      ]
      if (!beat) return new Response(events.map(([event, data]) => new TextDecoder().decode(frame(event, data))).join(""),
        { headers: { "content-type": "text/event-stream" } })
      // Leave the response open after its first frame: a runner that waits for
      // output instead of aborting at message_start trips the deadline below.
      let timer
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(frame(...events[0]))
        timer = setTimeout(() => {
          beatTailSent = true
          for (const event of events.slice(1)) controller.enqueue(frame(...event))
          controller.close()
        }, 8000)
      }, cancel() { clearTimeout(timer); beatCancelled = true } })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  let proxy
  try {
    const { createProxyServer } = await load("src/proxy/server.ts")
    const { lookupSharedSession } = await load("src/proxy/sessionStore.ts")
    const { verifyLineage } = await load("src/proxy/session/lineage.ts")
    const { parseSSE } = await load("src/__tests__/helpers.ts")
    const { telemetryStore } = await load("src/telemetry/index.ts")
    const { estimateTokens } = await load("src/proxy/replayBudget.ts")
    proxy = createProxyServer({ silent: true, profiles: [{ id: "offline", type: "api", apiKey: "offline-dummy-key", baseUrl: upstream.url.origin }], defaultProfile: "offline" })
    const tools = [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }]
    const post = async history => {
      phase = "real"
      turn++
      const response = await proxy.app.fetch(new Request("http://fixture.invalid/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-meridian-agent": "pi", "user-agent": "pi/1.4.0", "x-session-affinity": `keepalive-${arm}` },
        body: JSON.stringify({ model: "opus[1m]", max_tokens: 400, stream: true, tools, messages: history,
          ...(thinking ? { thinking: { type: "enabled", budget_tokens: 1024 } } : {}) }),
      }))
      const body = await response.text()
      assert.equal(response.status, 200, body)
      assert(!body.includes("event: error"), body)
      const visible = []
      const json = new Map()
      for (const { event, data } of parseSSE(body)) {
        if (event === "content_block_start") visible[data.index] = { ...data.content_block }
        if (event !== "content_block_delta") continue
        const d = data.delta
        if (d.type === "text_delta") visible[data.index].text += d.text
        if (d.type === "thinking_delta") visible[data.index].thinking += d.thinking
        if (d.type === "signature_delta") visible[data.index].signature += d.signature
        if (d.type === "input_json_delta") json.set(data.index, (json.get(data.index) ?? "") + d.partial_json)
      }
      for (const [index, input] of json) visible[index].input = JSON.parse(input)
      return visible
    }
    const mapping = () => lookupSharedSession(`offline:keepalive-${arm}`)
    const continueWith = async history => {
      const current = mapping()
      assert(current, "continuation requires a mapping")
      const checkLineage = incoming => assert.equal(verifyLineage({ ...current, lastAccess: 0 }, incoming).type, "continuation", "lineage must stay continuation")
      checkLineage(history)
      if (arm === "beat") red("lineage", checkLineage, history, mutant => { mutant[0].content = "modified ancestry" })
      const output = await post(history)
      assert.equal(telemetryStore.getRecent({ limit: 1 })[0].isResume, true, "real turn must actually resume")
      return output
    }
    let control
    let beatPrefix
    for (arm of ["control", "beat"]) {
      turn = 0
      let history = [{ role: "user", content: "read fixture" }]
      const first = await post(history)
      assert.deepEqual(first.filter(block => block.type === "tool_use"), calls, "every tool call must reach client")
      history = [...history, { role: "assistant", content: first }, { role: "user", content: count
        ? calls.map(call => ({ type: "tool_result", tool_use_id: call.id, content: result(call) })) : "continue fixture" }]
      const checkpoint = shape === "checkpoint" || shape === "checkpoint1" || shape === "wide"
      if (!checkpoint) {
        const output = await continueWith(history)
        history = [...history, { role: "assistant", content: output }, { role: "user", content: "final follow-on" }]
      }
      const before = wire.at(-1).body
      const current = mapping()
      assert(current, "real turn must publish its mapping")
      if (count > 1 && !checkpoint) {
        const blocks = before.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        assert.equal(blocks.filter(block => block.type === "tool_result" && block.tool_use_id === calls[0].id).length, 1, "hybrid must have one native first-call result")
        for (const call of calls.slice(1)) assert(!blocks.some(block => block.type === "tool_result" && block.tool_use_id === call.id), "later hybrid results must be records, not native")
        console.log(`PASS hybrid witness: ${count} calls; first native result and later completed-call records`)
      }
      if (checkpoint) assert.deepEqual(current.passthroughToolCallIds, calls.map(call => call.id), "beat must run while tool results are still pending")
      if (thinking && !checkpoint) assert(before.messages.some(message => message.content?.some?.(block => block.type === "thinking" && block.signature === "offline-signature")), "thinking/signature must reach resumed wire")
      const published = JSON.stringify(current)
      const transcripts = () => Object.fromEntries(readdirSync(root, { recursive: true })
        .filter(path => String(path).endsWith(".jsonl"))
        .map(path => [String(path), readFileSync(join(root, String(path)), "utf8")]))
      const sourceTranscripts = transcripts()
      if (arm === "beat") {
        phase = "beat"
        clock = Date.now() + keepalive.CACHE_KEEPALIVE_INTERVAL_MS + 1000
        proxy.tickCacheKeepalive()
        const deadline = performance.now() + 6000
        while (scheduler.inFlight && performance.now() < deadline) await Bun.sleep(20)
        const beats = wire.filter(row => row.phase === "beat")
        if (shape === "5m" || shape === "wide") {
          assertSkip(beats)
          red("ineligible skip", assertSkip, beats, mutant => { mutant.push({ phase: "beat" }) })
          console.log(`PASS keepalive skip: ${shape === "5m" ? "ephemeral_5m_input_tokens" : "9 pending calls (>8)"}; zero upstream requests`)
        } else {
          assert.equal(beats.length, 1, "exactly one beat must reach upstream")
          const abortWitness = { inFlight: scheduler.inFlight, cancelled: beatCancelled, tailSent: beatTailSent }
          assertAbort(abortWitness)
          red("first-response abort", assertAbort, abortWitness, mutant => { mutant.tailSent = true })
          console.log("PASS beat abort: upstream cancelled after message_start; no output sent")
          const beat = beats[0].body
          const checkPrefix = request => assertPrefix(before, request)
          checkPrefix(beat)
          red("system bytes", checkPrefix, beat, mutant => { mutant.system[0].text += "CORRUPTED" })
          red("tools bytes", checkPrefix, beat, mutant => { mutant.tools[0].description = "CORRUPTED" })
          red("message content prefix", checkPrefix, beat, mutant => { mutant.messages[0].content[0].text += "CORRUPTED" })
          beatPrefix = { bytes: Buffer.byteLength(JSON.stringify({ system: before.system, tools: before.tools, messages: before.messages })),
            estimatedTokens: estimateTokens(JSON.stringify({ system: before.system, tools: before.tools, messages: before.messages })), method: "Meridian replayBudget estimate (not provider tokenization)" }
          console.log("PASS beat prefix: byte-identical system/tools; R1 message content unchanged " + JSON.stringify(beatPrefix))
        }
        const checkMapping = value => assert.equal(JSON.stringify(value), published, "beat must not change mapping")
        checkMapping(mapping())
        const checkTranscripts = value => assert.deepEqual(value, sourceTranscripts, "beat must neither alter source transcripts nor persist a fork")
        checkTranscripts(transcripts())
        red("transcript immutability", checkTranscripts, transcripts(), mutant => { mutant[Object.keys(mutant)[0]] += "corrupted" })
        red("mapping immutability", checkMapping, mapping(), mutant => { mutant.claudeSessionId = "corrupted" })
      }
      const follow = await continueWith(history)
      assert(follow.some(block => block.type === "text"), "follow-on must complete")
      const actual = wire.at(-1).body
      if (arm === "control") control = modelInput(actual)
      else {
        assertControl(control, actual)
        red("no-beat control", request => assertControl(control, request), actual, mutant => { mutant.max_tokens++ })
        assertNoLeak(actual)
        red("prompt isolation", assertNoLeak, actual, mutant => { mutant.messages.push({ role: "user", content: keepalive.CACHE_KEEPALIVE_PROMPT }) })
        red("output isolation", assertNoLeak, actual, mutant => { mutant.messages.push({ role: "assistant", content: "KEEPALIVE_PARTIAL_OUTPUT_SENTINEL" }) })
        assertResults(actual, calls, result)
        if (count) red("exactly-once results", request => assertResults(request, calls, result), actual, mutant => { mutant.messages.push({ role: "user", content: result(calls[0]) }) })
        const beat = wire.find(row => row.phase === "beat")?.body
        if (beat) {
          assertPrefix(before, actual)
          assert.equal(JSON.stringify(contentPrefix(beat.messages.slice(0, before.messages.length))), JSON.stringify(contentPrefix(actual.messages.slice(0, before.messages.length))), "beat must warm the same prefix as follow-on")
        }
        console.log("PASS follow-on: no-beat control byte-identical (session metadata excluded); continuation; real results exactly once; no beat prompt/output" + (beat ? "; same warmed prefix" : "; ineligible skip"))
      }
      // Control must not become a second due entry when the fixture advances time.
      scheduler.forget("pi:keepalive-control")
    }
    console.log(JSON.stringify({ shape, beatPrefix, cli: Bun.spawnSync([cli, "--version"]).stdout.toString().trim(), sdk: JSON.parse(readFileSync(join(sourceRoot, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"))).version,
      upstreamCalls: wire.length, liveModelCalls: 0 }))
  } finally {
    if (arg("wire")) writeFileSync(arg("wire"), JSON.stringify(wire, null, 2) + "\n")
    await proxy?.closeBackend?.()
    upstream.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}
