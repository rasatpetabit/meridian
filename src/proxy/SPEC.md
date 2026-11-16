---
id: proxy-core
type: module-design
status: active
title: Proxy core (HTTP orchestration and Claude request path)
parent: architecture
depends-on: [adapters, session, profiles-routing, plugins, antigravity-backend, chatgpt-backend, telemetry-ui]
references: [api-contract]
---

## Responsibility

The server and the default Claude request path:

- `server.ts` — owns the public listener and route registration (it mounts the
  Hono sub-app built in `telemetry/routes.ts`; adapters and `auth` use Hono's
  `Context` type only), backend selection
  (`claude` / `antigravity` / `combined`), request orchestration, SSE
  streaming, health/readiness, settings and operator routes;
- the Claude turn: SDK query options (`query.ts`), model mapping (`models.ts`),
  content normalization and sanitizing, passthrough tool forwarding, replay
  rendering, structured output, idle/stall guards;
- admission and lifecycle: concurrency semaphore, generation admission and the
  `/drain` hold, per-request abort, `sessionTree.ts` subtree cancellation,
  shutdown drain, upstream reachability;
- errors and throttling (`errors.ts`, `retryAfter.ts`, `sseFailureSniff.ts`);
- protocol translation (`openai.ts`, `openaiResponses.ts`) and build
  provenance / update check (`build*.ts`, `updateCheck.ts`, and
  `pluginUpdateCheck.ts` for loaded plugins' npm packages in the same opt-in
  pass — see [`plugins`](plugins/SPEC.md));
- process-level services beside it: settings/config (`src/settings.ts`,
  `src/configDir.ts`, `src/headerSettings.ts`, `src/sameOrigin.ts`), logging,
  MCP tool definitions (`src/mcpTools.ts`) and opt-in crash reporting
  (`src/errorReporting/`, off without a DSN and never changes whether the
  process dies).

## Boundary

- `server.ts` **orchestrates**; route handlers stay thin and delegate to
  extracted modules. New pure logic becomes a new leaf module with unit tests.
- Leaf modules (`errors`, `retryAfter`, `toolInputJson`, `models`, `tools`,
  `messages`, `profiles`, `profileCli`, `buildInfo`, `updateCheck`,
  `pluginUpdateCheck`, `sseFailureSniff`) never import `server.ts`, `session/` or `adapter.ts`;
  `buildInfo`, `retryAfter`, `toolInputJson` are additionally pure.
- `query.ts` builds SDK options **through the adapter interface**, never from
  tool constants directly.
- No `as any`, `@ts-ignore`, `@ts-expect-error` or empty catch blocks.

The full file-level rules, throttling and cancellation contracts are in
[`architecture`](../../ARCHITECTURE.md) → *Dependency Rules*, *Throttling
Contract*, *Cancellation Contract*; public routes and headers are in
[`api-contract`](../../.agents/references/api-contract.md).

## Decisions

- **Streaming failure events describe unrecovered turns.** After SDK error
  classification, a usable captured/uncaptured tool handoff or capped-turn
  truncation logs `upstream.completed` with the normal streaming fields plus
  `sdkTermination` and `recovery` (`tool_use`, `tool_use_uncaptured`, or
  `max_tokens`), not `upstream.failed` / `proxy.anthropic.error`. Other exits,
  including failed recovery publication, retain both failure events exactly
  once with their original classification and stderr. This changes no recovery,
  telemetry, idle-streak or wire behavior. See
  [exit audit and live log evidence](../../docs/maintenance/PASSTHROUGH_HANDOFF_LOGGING.md).

- **Externally stopped Claude Code processes are transient.** SDK exits 143
  (SIGTERM) and 137 (SIGKILL), including the SDK's null-code `terminated by
  signal SIGTERM/SIGKILL` form, return 503 `api_error` with “Service temporarily
  unavailable” and retry advice, not login advice. Earlier global auth,
  entitlement, quota and request-error classification keeps precedence. This
  does not enable account failover (only quota/billing classes do that).
  Shutdown still drains admitted work before its deadline; deadline expiry
  force-closes sockets rather than promising delivery of an SSE error. See
  [signal/drain evidence](../../docs/maintenance/SIGNAL_EXIT_TRANSIENT.md).

- **OpenAI Responses (`/v1/responses`) for Codex** is pure translation
  forwarded in-process to `/v1/messages`, reusing auth, model mapping, sessions
  and the tool loop.
  - Only developer messages **before** the conversation starts fold into
    `system`; later ones stay in history, because rewriting `system` invalidated
    the whole prompt cache (observed 14/14 collapses).
  - Incoming reasoning items are dropped; when reasoning is requested an empty
    placeholder reasoning item is emitted, because Codex 0.144 hangs without
    one. Cross-turn thinking comes from SDK session resume, one session per
    Codex thread: turn metadata comes from the `x-codex-turn-metadata` header,
    else the body's `client_metadata`; the key is its `thread_id`, else
    `prompt_cache_key`. Spawned subagent threads (which inherit the parent's
    `prompt_cache_key`) and side requests such as `compact` or `title` get
    keys of their own, because keying them on the thread alone made them
    rewrite the live conversation's session.
  - A mid-stream upstream error emits `response.failed` so Codex does not hang.
  - Codex is a tool-driving client, so this path always runs in passthrough.
- **OpenAI Chat Completions:** unkeyed clients get prior turns packed into one
  history block (full history every turn would otherwise read as undo or
  divergence); clients with a recognized session key keep real history so
  lineage can resume.
  - Content parts map to Claude blocks: `text` and assistant `refusal` to
    text, data-URL `image_url` to image, a base64 PDF data URL in `file` to
    document, through the same `parseDataUrlImage` / `parseDataUrlPdf` the
    Responses adapter uses. In user, assistant and tool messages a part that
    cannot be delivered (remote image URL, `file_id`, another file type,
    `input_audio`, an unknown type) becomes a bracketed omission note, never a
    silent drop (#1482): a dropped part let the request succeed while Claude
    never saw the input and nothing said so. System messages are flattened to
    text. Packed history renders an earlier turn's images and documents as
    `[Image attached]` / `[Document attached]`, so unkeyed, only the latest
    turn's media reaches the model (media nested in a packed tool result is
    still dropped).
- **Explicit Claude versions disable refusal model switching.** The existing
  per-request family pin also sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1`
  for recognized versioned Claude IDs. Native refusal fallback can otherwise
  change the model after initial alias resolution. Bare aliases keep their
  inherited behavior. Refusals and same-model refusal retries are unchanged;
  an independently configured SDK `fallbackModel` remains outside this switch.
- **Per-model 1M override.** `[1m]` stays the default for Opus and Fable;
  `MERIDIAN_OPUS_MODEL=opus` / `MERIDIAN_FABLE_MODEL=fable` opt a tier out
  (Mythos follows Fable). Values are normalized; an unrecognized value warns
  once and keeps the default, because with Extra Usage enabled a silent 1M
  choice is silently billed. A generic multi-tier switch was rejected.
- **Claude Fable 5.2 and Mythos 5.2 catalog and pricing.** Advertised with
  official 1M context and always-on adaptive thinking
  (`thinking.types.adaptive` supported, `enabled` false), matching the
  official model overview
  (https://platform.claude.com/docs/en/models/overview,
  https://www.anthropic.com/claude-fable-and-mythos-5-2). Both route through
  the existing Fable tier alias (`fable[1m]`) with per-request model pinning
  to the requested `claude-fable-5-2` / `claude-mythos-5-2` id, preserving
  canonical `claude-fable-5-1` as the bare alias default; Mythos has no
  separate SDK alias and shares the Fable tier like earlier Mythos
  generations. Telemetry prices both 5.2 models at identical official rates:
  $8/M input, $40/M output, $0.20/M cache read, $10/M 5-min cache write
  (https://platform.claude.com/docs/en/about-claude/pricing); historical
  Fable/Mythos generations keep their FABLE rates.
- **JSON passthrough preserves the complete refused tool batch.** Claude Code
  may split one model turn into one assistant fragment per parallel call, even
  when a CLI refusal arrives before the final fragment's metadata. Once a
  fragment puts a tool_use in the JSON response, accept later fragments only
  when their nonempty Anthropic `message.id` equals that tool-bearing response's
  ID. A growing tracker is not proof of same-model-turn membership. Missing,
  empty or different response IDs fail closed: suppress the entire later
  fragment, including text, thinking and new tool calls. Use the same rule for
  the visible stop reason. Update the client assistant UUID on that same
  response only when a client-forwarded call is already visible; an internal
  tool such as StructuredOutput does not count, so a schema-validation retry
  with a new response ID still records its own assistant UUID. Both stay
  independent of early-stop settlement, its kill switch, SDK fragment UUIDs
  and wire-boundary timing.
  On normal JSON completion, forward every same-turn refused call with its
  original ID, input and order, and `stop_reason: "tool_use"`, matching SSE
  delivery, even when metadata follows message_stop. Drain the hidden second
  turn of a client-forwarded batch without exposing its content or replacing
  the visible stop reason or assistant UUID. Multi-call mappings still evict
  and the next request replays every real client result; this changes neither
  SSE behavior nor checkpoint eligibility.
  At the proxy's one-turn cap, JSON also recovers `error_max_turns` only when
  the final attempt's client tool-block starts, visible tool_use IDs and exact
  CLI `No such tool available` rejection IDs are identical, with matching
  resolved names. Every wire record must be naturally closed and complete;
  duplicate starts/IDs, unsurfaced wire blocks, visible calls without records
  and extra rejections fail closed. Each visible object input must deep-equal
  strict `JSON.parse(record.json)` when that wire string is non-empty, and
  otherwise the inline input object from `content_block_start`. An empty wire
  string with no inline object, unparseable JSON, or any other mismatch cannot
  authorize a call SSE did not prove. Reuse the SSE uncaptured recovery veto
  with the wire-start count and its input-completeness check. The proof keeps
  its own attempt-scoped set of wire-started client tool ids, reset with the
  other wire and rejection proof at every SDK attempt, including fresh
  resume/model fallback. That reset does not clear or refill the pre-existing
  `streamedToolUseIds` completeness oracle; early-stop coverage and checkpoint
  publication keep using it as before this proof. Read the actual constructed
  attempt's budget. The pre-existing JSON
  assembly loop can retain error-assistant content across a retry: if any
  content survives into a later attempt, veto this new recovery, without
  changing the retry/assembly loop. Cancellation, revoked writes, duplicate or
  forced-single calls, and the recovery kill switch (including its legacy
  `CLAUDE_PROXY_` alias) keep failing closed.
  This does not enable opt-in abort-window recovery or larger-budget JSON
  error recovery. As in SSE, a fully rejected undeclared name is delivered as
  written for the client's invalid-tool result: rejection proves it ran nowhere;
  declaration is required only without that proof. The response-identity gate
  above remains authoritative for content. Hidden-response fragments never join
  the recovered JSON batch, and a client tool block started in any response
  other than the delivered one makes capped JSON recovery fail closed (the
  pre-existing HTTP 500): at the single-turn cap the CLI makes one upstream
  model call. On Claude Code 2.1.322, the captures
  `/mnt/ai-scratch/meridian-json-capped-500/evidence/round2/cli-2-wire.json` and
  `cli-3-wire.json` each hold exactly two upstream requests, the capped turn and
  the follow-up carrying the real tool results. Invalidate the exact-generation
  mapping before releasing recovered calls, and fail closed on an eviction
  conflict. JSON publishes no
  native-call marker and supplies no capture proof for rejected calls, including
  a single call, so its existing publication guard cannot retain these mappings.
  Follow-up real results therefore replay fresh, each exactly once.
  See the dated JSON forwarding and capped-recovery evidence in
  `docs/maintenance/MIXED_REJECTION_CHECKPOINT.md`.
- **A canonical single-turn name-dispatch refusal can retain a keyed tool
  checkpoint without PreToolUse capture.** The CLI can reject a bare client
  tool name before invoking hooks even though its assistant UUID and rejection
  are durably written at `error_max_turns`. Requiring hook capture to publish
  that checkpoint discarded fresh replays and cold-cached every following
  turn. Retain it only after observing the canonical SDK result at the
  one-turn cap, with exactly one complete streamed call declared by the
  client, an id/name-matched CLI name-dispatch refusal for that call, no
  dropped calls, and the ordinary settled assistant UUID/full-call-set and
  publication guards. Resume rewinds before the rejection and appends the
  real client result. Apart from this exception and the qualified mixed hybrid
  below, checkpoint retention requires positive PreToolUse capture proof for
  every call ID, on JSON completion, SSE completion and captured-error recovery.
  Other uncaptured calls evict the checkpoint, including InputValidationError
  and single-call deferred completion. JSON also checks
  all emitted assistant and streamed call IDs independently of its frozen
  candidate: without boundary events, a later fragment must not hide an
  uncaptured call behind an earlier captured call.
  **Qualified streamed multi-call batches use first-fragment hybrid
  continuation** (operator-approved Design A, 2026-11-14). Retain only a
  canonical settled checkpoint covering every streamed/client-visible call,
  with positive PreToolUse capture for every observed call and a first
  assistant fragment containing exactly one tool use.
  **Mixed name-dispatch batches of two or three calls also qualify** at the
  one-turn cap, with at least one captured call: every uncaptured call must
  have an id/name-matched CLI name-dispatch refusal (`cliUnavailableToolIds`),
  name a declared client tool, and have a naturally closed, strictly valid
  JSON object input on the client wire. Raw-control-character repair is not
  qualification. Require the exact complete streamed/tracked call set, no
  dropped calls, no deferred tools or client ToolSearch, and the same canonical
  SDK-result/publication/abort guards. Keep this proof separate from actual
  PreToolUse capture; it applies only with the explicit hybrid marker. Either
  the first call or later calls may be bare. Rewind before every CLI rejection;
  none of its text may appear in any resumed upstream request. Store that first
  UUID, all pending client IDs and `passthroughNativeToolCallId` identifying the
  first call. On the next exact complete-result continuation, send one SDK
  user input: that call's native real result, then completed-call/result
  records for the remaining calls, then any queued user content. Reuse
  `flattenAssistantContent` and `normalizeStructuredUserContent` from fresh
  replay; preserve result payloads, error attribution and media. Call records
  name the registered MCP tools. The existing system note already explains
  that these records describe completed client-side work; do not change the
  system/tool prefix or ask the client to execute those calls again.
  Real SDK 0.2.141 / CLI 2.1.322 proves two-/three-call retention, every real
  result exactly once without placeholders, and unchanged upstream content
  prefixes through a second multi-call turn followed by a single-call turn.
  Errors, reversed client-result order and a native call-1 image are wire-proven.
  **Images in non-native results fail closed to fresh replay.** CLI 2.1.322
  appends an image-source annotation to top-level hybrid images followed by
  text, changing the trailing result text (a newline is added). Two-call
  image-last probes passed, but later-result images conservatively replay
  regardless of position so queued content cannot introduce that unproved
  shape. Native call-1 images remain wrapped and retain the proved prefix.
  Only cache markers and the CLI's equivalent string/singleton-text-block
  environment representation are canonicalized for prefix comparison; no
  text, message order, tool definition or system content is ignored.
  Last-fragment native multi-call resume remains unqualified: four earlier
  probes lost later real results, and its CLI-internal cause remains unknown.
  The consolidated hybrid assistant has no complete native undo boundary;
  its rollback UUID slot is null, so editing its results replays instead of
  trying a discarded later-fragment UUID. Ordinary undo remains unchanged.
  Legacy multi-call checkpoints without the explicit hybrid marker replay.
  Unqualified mixed/uncaptured batches, JSON completion, assistant-only/unstreamed
  SSE, silent-turn recovery, missing/ambiguous or grouped first-fragment boundaries,
  and incomplete/mismatched results retain their existing replay policy. Both
  canonical turn-cap drain-error recovery and normal streamed completion use
  the hybrid publication proof; deferred PostToolBatch still qualifies only
  all-captured batches. CLI 2.1.322 / SDK 0.2.141 offline mixed-wire tests prove
  bare-first/bare-later two-/three-call R1, exact-once real result fidelity and
  follow-on prefix preservation, including thinking. They do not measure live
  model tool-name selection, provider cache billing or production savings.
  The production motivation was 81/81 captured multi-call evictions in 8.5 h,
  139/143 new-lineage requests writing >=100k tokens (37.3M total), versus
  99.4% cache hits over 2269 continuation requests. These are observed token
  costs, not a measured post-fix production saving or a dollar estimate.
  Publication uses the shared `checkpointPublicationRequiresReplay` invariant:
  a tool turn requires a canonical settled assistant UUID and an exact match
  between its checkpoint IDs and the client-visible batch, with exactly one
  captured call or the explicit first-fragment hybrid proof above. SSE computes
  that batch from both streamed IDs and captured calls queued for the final
  envelope, not only partial stream events. An assistant-only batch can settle at publication after canonical drain; a
  captured single call still retains its rewind checkpoint. Any unqualified
  uncaptured assistant or wire call observed during drain invalidates publication
  even after the candidate latches, including suppressed wire-only fragments without
  assistant metadata. Cardinality applies to the client-visible batch, not
  hidden captured digest metadata pruned from that batch. JSON uses the same
  rule with its completed response blocks. Silent recovery must win either
  publication of its eligible fork or exact-generation mapping invalidation
  before releasing buffered recovery content; invalidated forks are abandoned,
  and a CAS loser withholds its calls. Plain text and captured single-call
  retention remain unchanged, as does the canonical single-call name-dispatch
  exception (which supplies only that call's otherwise missing capture proof).
  Fresh replay preserves all real
  client results at the cost of rebuilding the SDK prefix/cache and losing
  SDK-only context not present in client history. See
  `docs/maintenance/MIXED_REJECTION_CHECKPOINT.md` for red/green evidence and
  measured cache costs and exact hybrid input; last-fragment native multi-call
  resume remains unqualified. Abort-window
  calls without a result, malformed-input refusals, undeclared names, unkeyed requests and
  larger turn budgets remain ineligible for this rejection-only recovery
  retention. Retained checkpoints use ordinary continuation tool caching; the
  one-shot recovery tool grant remains only for evicted checkpoints.
- **Passthrough tool sets are shared by content, never by lifetime.** Sessions
  sending identical tools share one built definition set (#1410) and one raw
  tool list (#1444), found through process-wide indexes keyed by a digest of
  the exact bytes (tool, key and schema property order included) and held by
  `WeakRef`: an index never keeps anything alive, so the session caches alone
  bound memory. Measured with a 230-tool OpenCode list in isolated harnesses
  (not whole-server memory): built sets from about 20 MiB per session to one
  shared set; the remaining per-session heap from about 1 MiB to about 80 KiB. Shared values are read-only; each query still
  builds its own MCP server from them.
- **A client that defers tools is never auto-deferred; one that also brings
  its own `ToolSearch` gets the only search path.** The session pin holds the
  auto-defer answer (#861), so a threshold crossing cannot flip the tool
  block, `ENABLE_TOOL_SEARCH` or `maxTurns` mid-session. With a client
  `ToolSearch` (Claude Code): eager tools stay registered, a deferred tool
  joins them eagerly once referenced, unreferenced ones stay unregistered,
  Meridian adds no inner ToolSearch, `tool_reference` blocks reach the model
  as text naming the registered tool (a copied client name is undispatchable,
  #1107), and each discovery re-primes the prompt cache by changing the
  registered set. Other client-deferral keeps the inner ToolSearch and maps
  `tool_reference` names to the registered names at a checkpoint.
- **Transcript retention is opt-in and delegated to Claude Code (#1261,
  owner decision 2026-10-27).** Meridian's empty `settingSources` (#490/#634)
  also skips Claude Code's retention cleanup, so transcripts Meridian's own GC
  no longer tracks accumulate. `MERIDIAN_TRANSCRIPT_RETENTION_DAYS` /
  `transcriptRetentionDays` (1-3650; env `0` pins off) pass `cleanupPeriodDays`
  as a flag setting to request children; unset passes nothing, so an
  unconfigured instance sends exactly what it did before. `0` is never sent:
  Claude Code validates the key as a positive integer and older versions read
  `0` as "write no transcripts".
  - *Why opt-in:* the cleanup deletes every file of its kind older than the
    period in the whole config directory (transcripts Meridian still maps or
    pins, file history, plans, tasks, uploads, shell snapshots, debug logs,
    backups…), by mtime only, and can race a resume (`session` → *Known
    limitations*). That is a data-deletion choice for the operator.
  - *Why no Meridian-owned sweep yet:* the proposed idle sweep launched a
    promptless Claude Code child per profile root without process custody (its
    SDK slot was released before the child was joined, `close()` could succeed
    with it unjoined, root reservation raced) and exported
    `ProxyServer.transcriptSweep` without contract approval. Retention
    therefore runs only inside request children; a profile that serves no
    requests is not cleaned.
  - *Follow-ups:* a pin-aware transcript GC that honors durable mappings and
    publication leases, then an idle sweep with full process custody (slot held
    until the child is joined, joined on close, atomic root reservation).
  - Settings writes are same-origin only (`transcriptRetentionSettings.ts`).
- **`max_tokens` is not enforced by default:** the Agent SDK exposes no output
  cap, and the CLI's cap counts thinking plus text, so an answer-sized cap can
  leave no room for an answer. `MERIDIAN_ENFORCE_MAX_TOKENS=1` honors it exactly.
- **Prompt-cache keepalive** (#1193, contributed by @XInTheDark, redesigned
  with the owner 2026-10-26; `cacheKeepalive.ts` schedules, pure;
  `cacheKeepaliveRunner.ts` sends one beat).
  - *Measured TTL.* On the owner's Max account through the Agent SDK, turn 1
    wrote 42,663 tokens to the one-hour tier (`ephemeral_1h_input_tokens`,
    `ephemeral_5m_input_tokens: 0`) and turn 2, after 7 idle minutes, read all
    of them from cache (evidence `1193-cache-ttl-20261026`). The contributor's
    five-minute model therefore beat subscription sessions twelve times an
    hour for nothing; the benefit is only for idles longer than an hour.
  - *Operator switch, no header.* Off by default; `MERIDIAN_CACHE_KEEPALIVE`
    (wins) or the `cacheKeepalive` setting, re-read per turn and per tick. A
    beat is billed background traffic, so the operator decides; the
    contributor's `x-meridian-cache-keepalive` header was dropped rather than
    added to the public contract.
  - *Eligibility from usage.* Only a real turn of a keyed passthrough session
    on a `claude-max` profile is tracked, and only while its latest turn wrote
    the one-hour tier (any five-minute write, no tier breakdown, or a failed
    turn stops tracking; a pure cache read keeps the current period). A
    five-minute prefix would expire long before a beat.
  - *55 minutes, 3 beats.* One beat 55 minutes after the latest real turn
    started, and 55 minutes after each reached beat: five minutes of margin
    under the hour for tick jitter (10 s), the 15 s settle after a new
    mapping, a retry, and SDK start-up. At most three per idle period (≈3 h)
    bounds the cost of a session that never comes back. A real turn ends the
    period (and no beat runs while one is running); auxiliary/independent
    requests never touch the schedule.
  - *Main conversations only.* Subagent and one-shot requests (OpenCode's
    title and summary, delegated children) are never tracked: the live A/B
    showed OpenCode's title request keyed apart and carrying the full prefix,
    so a beat on it cost as much as the useful one for a conversation never
    resumed. They do not forget the key either, because an older V2 plugin
    sends compaction as a subagent source under the primary key.
  - *Measured* (2026-10-27, OpenCode 1.18.34, Sonnet 5.5, Max account, ~90k
    token unique prefix, 65 min idle): without keepalive the next turn
    rewrote 86,385 tokens; with it, one beat at 55.3 min read 90,018 and the
    next turn read 90,018 and wrote 340, about 89% cheaper in input-token
    equivalents net of the beat.
  - *Never on someone's money or an exhausted window.* No beat on API-key or
    token profiles, while any live window reports `isUsingOverage`, a
    rejected or fully used window, priority cooldown, a spent refusal, or a
    `[1m]` bench for the session's model. A beat always uses the profile the
    mapping was published under (the mapping key is profile-scoped) and never
    routes or fails over; a blocked beat retries 30 s later.
  - *Same lifecycle as a turn.* Beats run through `runGatedSdkQuery`, the
    gated, joined core of `runSdkQueryAttempt`: process gate, close and join,
    permit released only after the join. A beat takes no writer lease (it
    writes nothing and must not refuse a real turn on the same transcript);
    it pins the source transcript against GC until joined. Beats count in
    `getInFlightCount`, `beginDrain` aborts them, and `closeBackend` waits for
    them, so no CLI child is orphaned.
  - *Never ahead of real turns.* A beat takes an SDK permit only with
    `tryAcquire(1)`: never queued, never ahead of a waiter, never the last free
    permit; otherwise it is skipped and retried. A global in-flight cap
    (default 1, at most 2) bounds beats across sessions.
  - *Read-only.* `forkSession: true`, `persistSession: false`, `maxTurns: 1`,
    `DISABLE_AUTO_COMPACT`, stopped at `message_start`: no transcript, mapping
    or lineage change. A beat that read nothing (cache already gone) or wrote
    the five-minute tier stops tracking instead of paying again.
  - *The tier is a fact of the request upstream received.* A turn's tier is
    read from the usage it reported, whatever ended it: a tool-boundary stop
    (the single-turn cap's `max_turns`, the single-step abort) keeps the
    session tracked, since an agent waiting at a tool call is the main case.
    Only a client abort drops tracking. It usually evicts the session too; a
    session it keeps behind the interrupted-turn check (see `session` →
    *Interrupted turns*) stays untracked until a later turn writes the
    one-hour tier.

## Codex Responses wire contract

Captured from real Codex 0.143 traffic; a stand-in server emitting exactly these
events drove a clean Codex turn. Tests mirror these shapes.

```
request  model, instructions (~21KB), input[ message(developer|user|assistant,
         input_text|output_text) | function_call | function_call_output |
         reasoning ], tools[function, strict, parameters], tool_choice:"auto",
         parallel_tool_calls:true, reasoning{effort}, text{verbosity},
         stream:true, store:false, include:["reasoning.encrypted_content"],
         prompt_cache_key, client_metadata (carries the x-codex-turn-metadata
         fallback used for thread keying)
response response.created → response.in_progress → output_item.added →
         content_part.added → output_text.delta* → output_text.done →
         content_part.done → output_item.done → response.completed{usage}
         tool call: output_item.added(function_call) →
         function_call_arguments.delta*/.done → output_item.done
```

## Known limitations

- **Keepalive needs two SDK slots.** A beat never takes the last free permit,
  so with `MERIDIAN_MAX_CONCURRENT=1` keepalive never runs.
- **Keepalive tracking is unbounded in count.** Each tracked session holds its
  latest request recipe (system prompt, tool definitions) for up to about
  three idle hours; a busy shared instance with keepalive on holds one per
  active session.
- **Bun misses early disconnects:** under Bun the HTTP server does not notice a
  client that leaves before the first byte (a startup warning says so).
- **Anthropic server tools** (`web_search_*`, `web_fetch_*`) cannot be produced
  through the subscription path and are rejected with a 400.
- **Implicit SDK attachments** in passthrough are suppressed by default
  (`CLAUDE_CODE_DISABLE_ATTACHMENTS=1`), which also bypasses the CLI's
  kept-deferred-tools optimization.
- **Passthrough turns default to `maxTurns=1`** to stop at the tool boundary;
  the client must send another request after executing tools.

Further user-visible limitations: `docs/configuration.md` → *Known
limitations*.
