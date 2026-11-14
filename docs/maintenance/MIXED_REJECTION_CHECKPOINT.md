# Mixed and multi-turn rejected checkpoint evidence

## Verification and three-captured diagnosis (2026-11-14)

**Status: guard verification passed; separate pre-existing all-captured resume
result loss reproduced. No retention-policy change.** This section supersedes
the unrerun-check and unexplained-control blockers in the historical checkpoint
below, not its remaining live-model/client acceptance limits.

Implementation tested: `dd5badbc155e4ac95321dedc74bfb2c31864b56c`.
Production-baseline source comparison: `e1c37ba4f9a837fe898c28b1d5dadb0fcc17d563`.
Linux x64, Bun 1.3.14, Agent SDK 0.2.141, actual Claude Code 2.1.322 at
`/home/ras/.local/share/claude/versions/2.1.322`. All HTTP model requests used
scripted loopback APIs and disposable state, not live inference or :3456.

### Part 1 — final fixture verification

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts src/__tests__/passthrough-early-stop.test.ts --timeout 30000
# 279 pass, 0 fail, 2188 expect() calls; 279 tests across 2 files; exit 0
npm run typecheck
# > tsc --noEmit; exit 0
```

The exact two-file command with only `src/proxy/server.ts` and
`src/proxy/passthroughEarlyStop.ts` restored from `e07c2eb0` exits 1:

```text
SyntaxError: Export named 'checkpointHasUncapturedCalls' not found in module '.../src/proxy/passthroughEarlyStop.ts'.
195 pass
10 fail
1 error
1992 expect() calls
Ran 205 tests across 2 files.
```

Nine integration failures are assertion failures (eight capture-proof matrix
cases plus the no-boundary late-fragment case): `expect(received).toBeUndefined()`
receives a retained mapping. The additional file-load failure is expected
because the new pure-helper tests import a helper absent from e07c2eb0; it is
not evidence that those pure tests ran against the old implementation.
Both source files were restored byte-for-byte in Python `finally`, including
a printed `IMPLEMENTATION_RESTORED True`. No tests or assertions were changed.
Logs: `/mnt/ai-scratch/meridian-mixed-rejection/verify-{focused,e07-focused,typecheck}.log`.

All rows below use this command prefix (no retries):

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322
```

| Arguments | Exit | Upstream requests | Checkpoint | Outcome |
|---|---:|---:|---|---|
| default | 0 | 2 | retained | native result, rejection rewound |
| `--thinking --calls=1` | 0 | 2 | retained | native result, rejection rewound |
| `--thinking --calls=3` | 0 | 2 | evicted | every real result replayed |
| `--mixed --calls=2` | 0 | 2 | evicted | every real result replayed |
| `--mixed --calls=2 --input-validation` | 0 | 2 | evicted | every real result replayed |
| `--deferred --calls=2` | 0 | 3 | evicted | every real result replayed |
| `--deferred --calls=2 --mixed --captured-last --non-stream` | 0 | 2 | evicted | every real result replayed |
| `--deferred --calls=1` | 0 | 3 | evicted | real result replayed |
| `--deferred --calls=1 --non-stream` | 0 | 3 | evicted | real result replayed |
| `--deferred --calls=1 --input-validation` | 0 | 3 | evicted | real result replayed |
| `--captured --calls=1` | 0 | 2 | retained | native result, denial rewound |

The eight replay cases print
`PASS follow-up: fresh replay, not a resumed continuation; real client result for every call; no CLI rejection`.
The three retained cases print
`PASS continuation: native assistant and real client result for every call; rejection rewound`.
Every row's final JSON reports `liveModelCalls:0`; `CLIENT_CALLS` expected and
received counts match. These all passed both before and after adding the
harness diagnostics/pacing options. Final-harness logs are `final-cli-00.log`
through `final-cli-10.log` in the same scratch directory. Typecheck passed
again after the harness change; no application source changed in this phase.
The final focused rerun also reports 279 pass, 0 fail, 2188 assertions
(`final-focused.log`, exit 0); final typecheck is in `final-typecheck.log`.

### Part 2(a) — identical pre-existing failure

Run `--captured --calls=3` with the two implementation files restored from
e1c37ba4, then with dd5badbc. Both exit 1 at the identical result assertion:

```text
SHAPE {"mixed":false,"deferred":false,"nonStream":false,"captured":true,"capturedLast":false,"inputValidation":false,"checkpointRetained":true,"firstRequestCalls":1}
CLIENT_CALLS {"expected":3,"received":3}
PASS lineage: exact streamed assistant plus client results is continuation
RESUME_RESULTS {"real":["toolu_offline"],"internalError":["toolu_offline_1","toolu_offline_2"]}
AssertionError: resumed upstream lacks real client result for toolu_offline_1
```

Logs: `final-e1c37ba4-buffered.log`, `final-dd5badbc-buffered.log`.
Again, the implementation comparison used byte-preserving save/restore in
`finally` and printed `IMPLEMENTATION_RESTORED True`.

### Part 2(b) — all calls reach the client; loss is downstream

`firstRequestCalls` counts **upstream HTTP requests before the client follow-up**,
not tool calls (`scripts/e2e-offline-fresh-checkpoint.mjs:73-85`). One is the
correct value for three parallel calls in one response. The unchanged exact
client-call-set assertion passes (`scripts/e2e-offline-fresh-checkpoint.mjs:223-226`).
Thus the premise that only one call reached the client is false.

The fixture emits one `message_start`, then, for indices 0/1/2 in sequence,
`content_block_start`, `input_json_delta`, `content_block_stop`; only after
all blocks does it emit `message_delta(stop_reason=tool_use)`, then
`message_stop` (`scripts/e2e-offline-fresh-checkpoint.mjs:89-108`). This is the
ordinary Anthropic multi-block order, not one message-level stop per tool.
The installed official Anthropic SDK's `src/lib/MessageStream.ts:567-618,673-686`
accumulates these indexed blocks and sets the message stop reason at the final
message delta; it does not require interleaved starts or an artificial barrier
before PreToolUse. The local live parallel harness, read but **not run**, also
documents CLI per-block dispatch while later calls stream
(`scripts/e2e-stream-parallel.mjs:5-12`). No new upstream transport was invented.

A temporary passive trace (restored in `finally`) observed this actual CLI order:

```text
message_start
start(0), input(0), assistant(toolu_offline), PreToolUse(toolu_offline, generating=true), stop(0)
start(1), input(1), assistant(toolu_offline_1), stop(1)
start(2), input(2), assistant(toolu_offline_2), stop(2)
message_delta, message_stop
PreToolUse(toolu_offline_1, generating=false), user(deny toolu_offline)
PreToolUse(toolu_offline_2, generating=false), user(deny toolu_offline_1)
user(deny toolu_offline_2), result
```

The hook hold is intentional (`src/proxy/server.ts:4408-4419,4791-4805`):
release after generation, not on the first tool's block stop. The tracker unions
per-block expected IDs and independently observed resolved IDs
(`src/proxy/passthroughEarlyStop.ts:111-174`), requires every expected ID resolved
(`:180-186`), requires equality with the streamed set (`:458-467`), and only then
allows a UUID-backed freeze (`:470-480`). The server additionally requires no
active generation and no open client blocks (`src/proxy/server.ts:6832-6844`),
and freezes the complete expected set (`:6257-6271`). The traced mapping contains
all three IDs and the final tool assistant UUID; the actual transcript contains
three assistant fragments followed by three denial results. No evidence here
supports a premature single-call freeze.

On the follow-up, passive instrumentation at `makePrompt`
(`src/proxy/server.ts:4370-4374`) saw **one SDK user input containing all three
native real tool_result blocks**. On the next loopback upstream request, the
native assistant still has all three calls, but its user result contains:

```text
toolu_offline_1: [Tool result missing due to internal error] (is_error=true)
toolu_offline_2: [Tool result missing due to internal error] (is_error=true)
toolu_offline:   REAL_CLIENT_RESULT_toolu_offline
```

Trace logs: `trace-control.log`, `shape-paced-e1c37ba4.log`,
`shape-paced-dd5badbc.log`. This localizes loss between SDK input and upstream
request on the resumed CLI path, not in the client response or Meridian's
structured-input wrapper. It does **not** identify the exact CLI internal cause.
Temporary instrumentation was removed; no SDK/CLI package was edited.

### Part 2(c) — paced/distinct production-like reproduction; stop

To test both buffered delivery and same-tool dispatch hypotheses without
weakening any assertion, the durable harness now accepts:

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322 \
  --captured --calls=3 --sse-delay-ms=25 --distinct-tools
```

This sends **three different registered tools** (`mcp__oc__read`,
`mcp__oc__read_1`, `mcp__oc__read_2`), with each frame enqueued individually
and separated by 25 ms. All block stops still precede the sole message delta
and message stop. Each call has valid, distinct JSON input. At maxTurns=1 all
three receive the real forwarding denial; the unchanged HTTP client's exact
assistant and grouped real results form a valid continuation, resumed at the
stored assistant checkpoint. This is the most production-like shape tested,
not a claim of a captured production provider stream.

**Both e1c37ba4 and dd5badbc exit 1 with exactly the Part 2(a) output above.**
Logs: `final-e1c37ba4-paced-distinct.log`, `final-dd5badbc-paced-distinct.log`.
Pacing alone, without changing tool names, also fails identically on both.
The first throwaway distinct-tool probe had an overbroad fixture substitution
(`ReferenceError: index is not defined`) and was not used as defect evidence;
the corrected probes and final committed harness reach the real-result
assertion. These are explicit shape experiments, not green-until-pass retries.

Conclusion: **a pre-existing real SDK/CLI-path result-loss defect under these
conditions, not a harness artifact explained by SSE chunking or repeated tool
names**. No all-captured retention change, production repair or further
implementation attempted. Resolve the separate resume defect before claiming
all-captured parallel result delivery is qualified.

The named production journal snapshot has 64 `checkpoint_ready(captured=2)`
and 7 `captured=3` events. Correlation by request ID finds 63 and 7 matching
persisted `toolCalls` counts respectively; the remaining two-call ready event
at line 11886 has no matching persisted event in this snapshot. A three-call
example is ready/persisted at lines 7753/7756. The snapshot contains zero
`tool_use ids were found without tool_result` errors. The operator also reports
zero since 11-01; that larger interval was not independently queried here.
Those facts establish successful checkpoint capture/publication, **not content
of the subsequently delivered results**. CLI internal-error placeholders
satisfy tool ID pairing, so the demonstrated loss need not cause that API error.
There is no evidence here that these actual production turns lost results.

### Changes and limits

Only the harness and evidence/documentation changed since dd5badbc. The harness
adds optional paced SSE and distinct registered names plus count/result-ID
summaries; default fixture bytes and all acceptance assertions are preserved.
No new product/architecture choice was made. The owning operator retains the
separate decision about remediation of the all-captured resume defect.
`git diff --check` passes. No push, build, install, full suite, restart, service
request or live model call occurred. Independent final review and affected
actual-model/client acceptance remain unperformed; the separate non-stream
parallel forwarding and absent-boundary reachability limits below remain open.

## Capture-proof follow-up — BLOCKED, not qualified

Follow-up baseline: `e07c2eb015beb71315d8e117381de17a66887bfa`.
The implementation now uses `checkpointHasUncapturedCalls` and the existing
PreToolUse `forwardedToolUseIds` at JSON completion, SSE completion and
captured/rejected recovery. Exactly one exception remains: the existing
`canonicalRejectedCheckpoint`, with its conditions unchanged. In particular,
single-call deferred rejections now evict. Captured single/multi-call
retention eligibility is unchanged. The name-dispatch-only set remains solely
for proving the canonical exception, not for excluding other refusals.

JSON additionally checks every client-tool ID emitted in assistant metadata
and stream events, including metadata consumed after early-stop latches. This
covers advisory 1's absent-boundary fragment shape even when it is missing
from the frozen candidate. A new mocked-SDK regression scripts that shape.
`query.ts` requests `includePartialMessages: true` for passthrough on both
paths, and `withReachability` does not buffer partial messages in that mode.
However, **real CLI 2.1.322 absent-boundary reachability remains unresolved**:
no passive SDK event-order witness was completed before the stop below. Do
not infer impossibility from the requested option. The independent emitted-ID
check fails closed regardless; repairing JSON's existing missing parallel-call
forwarding is not part of this patch.

### Stop condition: all-captured real-CLI result loss

The extra control below exited 1 on the capture-proof implementation:

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322 \
  --captured --calls=3
```

```text
SHAPE {"mixed":false,"deferred":false,"nonStream":false,"captured":true,"capturedLast":false,"inputValidation":false,"checkpointRetained":true,"firstRequestCalls":1}
PASS lineage: exact streamed assistant plus client results is continuation
AssertionError: resumed upstream lacks real client result for toolu_offline_1
```

The harness verified forwarding denials in the real transcript for all three
registered calls before reaching this assertion. This is outside the settled
change (all-captured retention must remain unchanged). No retry, assertion
weakening, alternate retention policy or live-service change was attempted.
Verification stopped as instructed. This is a blocked local implementation
checkpoint, not a completed fix or an integration candidate. The parent must
resolve the scope conflict before qualification continues.

### Evidence completed before the stop

Same Linux/Bun/SDK/CLI versions as the historical record below. All probes
use loopback fixtures, disposable state and zero live model calls.
Logs: `/mnt/ai-scratch/meridian-mixed-rejection/capture-*.log`.

- Real InputValidationError is reachable with the committed harness:
  `--mixed --calls=2 --input-validation` emits raw-tab JSON to the registered
  name, and checks the CLI transcript's exact InputValidationError prefix.
  On e07c2eb0 it exits 1:
  `AssertionError: resumed upstream lacks real client result for toolu_offline_1`.
  On the capture-proof implementation it exits 0, with
  `checkpointRetained:false`, `upstreamCalls:2`, `liveModelCalls:0`, and
  `PASS follow-up: fresh replay, not a resumed continuation; real client result for every call; no CLI rejection`.
- The real `--deferred --calls=1 --input-validation` baseline exits 1 at
  `uncaptured checkpoint must be evicted except the canonical single-call name-dispatch control`
  (`true !== false`). Its green run was not reached after the stop.
- All eight requested real-CLI controls exit 0: default,
  `--thinking --calls=1`, `--thinking --calls=3`, `--mixed --calls=2`,
  `--deferred --calls=2`,
  `--deferred --calls=2 --mixed --captured-last --non-stream`,
  `--deferred --calls=1`, and `--deferred --calls=1 --non-stream`.
  Each reports `liveModelCalls:0`; expected total upstream calls are
  respectively 2, 2, 2, 2, 3, 2, 3, 3. `--captured --calls=1` also exits 0
  and preserves native resume. The subsequent three-captured control fails
  as recorded above, before the additional deferred-input probes.
- Preliminary focused run:
  `bun test src/__tests__/passthrough-early-stop-integration.test.ts src/__tests__/passthrough-early-stop.test.ts --timeout 30000`
  reports **278 pass, 0 fail, 2182 assertions**. Existing captured,
  canonical-rejected and all-captured mocked retention tests were unchanged.
  This run predates the new no-boundary regression and the fixture correction
  below, so it is not final-head evidence.
- Preliminary baseline integration run after adding the no-boundary case:
  **195 pass, 9 fail, 1992 assertions**, exit 1. Eight failures are the
  uncaptured-refusal matrix; the ninth is the no-boundary fragment case.
  The added name-dispatch non-stream H1 case already passes on e07c2eb0;
  it is a missing-coverage control, not a new baseline failure.
- `npm run typecheck`: exit 0, `tsc --noEmit`, after adding the no-boundary
  test and before the fixture correction below.

**Evidence limitation discovered during final diff inspection:** the shell
adapter expanded `${call.name}` inside the newly generated integration
fixture, so those preliminary mocked runs used an InputValidationError-shaped
string without its tool name. The fixture now has the exact named refusal,
and the no-boundary test key again includes its run ID. Those corrected tests
and the final focused/typecheck gates have **not** been rerun because of the
explicit stop condition. The real-CLI raw-tab red/green evidence is unaffected.
The harness keeps strict JSON.parse for ordinary controls and repairs JSON
only for the explicit raw-tab control; final bytes of that narrow harness
change also remain unqualified. No full suite, build, install, push, restart,
live-service request or live model was run. The historical record below
qualifies only the earlier e07c2eb0 patch, not this blocked follow-up.

## Historical e07c2eb0 scope and outcome

Baseline: `e1c37ba4f9a837fe898c28b1d5dadb0fcc17d563` (fork main).
Linux x64, Bun 1.3.14, Agent SDK 0.2.141, Claude Code 2.1.322 at
`/home/ras/.local/share/claude/versions/2.1.322`.
The checks use the real HTTP handler, SDK and CLI against a scripted loopback
Anthropic SSE upstream. No live model, installed-service request, restart,
build, dependency install, push or release was performed.

H1 and H2 reproduce real client-result loss despite valid lineage and a durable
checkpoint. The fix evicts a parallel checkpoint if any of its call IDs has a
CLI name-dispatch rejection. It applies to captured recovery and normal SSE/JSON
completion. Rejection tracking for this safety gate is independent of the
uncaptured-recovery kill switch. Single-call retention and all-captured
checkpoint eligibility are unchanged. Full replay costs more but preserves
client-owned results. No new public API or routing policy was introduced.

## Reproducers and red/green evidence

All commands below use this prefix:

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322
```

The final harness was run with the two implementation files temporarily restored
from `git show e1c37ba4:<path>` and then restored to the guarded implementation
in a `finally` block. Thus the same final assertions ran against both versions.
All three baseline reproductions exited 1 at the upstream real-result assertion,
not at a mapping-policy assertion. Each fixed reproduction exited 0.

### H1 — REPRODUCED

Arguments: `--mixed --calls=2`.

The first call uses `mcp__oc__read`, reaches PreToolUse and receives Meridian's
forwarding denial. The second uses bare `read`, is rejected before PreToolUse,
and gets the CLI's `No such tool available` result. The harness verifies both
facts in the actual CLI transcript. At the one-turn cap:

```text
SHAPE {"mixed":true,"deferred":false,"nonStream":false,"captured":false,"capturedLast":false,"checkpointRetained":true,"firstRequestCalls":1}
PASS lineage: exact streamed assistant plus client results is continuation
AssertionError: resumed upstream lacks real client result for toolu_offline_1
```

With the guard, `checkpointRetained:false`; exactly two upstream calls:

```text
PASS follow-up: fresh replay, not a resumed continuation; real client result for every call; no CLI rejection
```

### H2 — REPRODUCED (normal completion on both paths)

SSE arguments: `--deferred --calls=2`.

An unused deferred tool lifts maxTurns to 4. Both bare calls are rejected before
hooks. A second upstream model turn emits `hidden digest` with `end_turn`, and
the CLI completes normally instead of exhausting its budget. The transcript
must contain this hidden assistant. The client sees only the original tool turn.
Baseline:

```text
SHAPE {"mixed":false,"deferred":true,"nonStream":false,"captured":false,"capturedLast":false,"checkpointRetained":true,"firstRequestCalls":2}
PASS lineage: exact streamed assistant plus client results is continuation
AssertionError: resumed upstream lacks real client result for toolu_offline
```

Fixed: `checkpointRetained:false`, three upstream calls (tool turn, hidden
digest, fresh follow-up), every distinct real result present and no CLI rejection.

JSON arguments: `--deferred --calls=2 --mixed --captured-last --non-stream`.

The rejected call comes first; the second call uses the registered name and is
backfilled from capture into the JSON response. Both calls are returned to the
client. The real CLI's PostToolBatch stops this captured batch with successful
completion at maxTurns 4, before a digest. It reaches the ordinary JSON store
path, not streaming rejection recovery. Baseline:

```text
SHAPE {"mixed":true,"deferred":true,"nonStream":true,"captured":false,"capturedLast":true,"checkpointRetained":true,"firstRequestCalls":1}
PASS lineage: exact streamed assistant plus client results is continuation
AssertionError: resumed upstream lacks real client result for toolu_offline
```

Fixed: `checkpointRetained:false`, two upstream calls, every real result present
in fresh replay and no CLI rejection.

Reachability limits and safe controls:

- Real CLI JSON with two bare/rejected calls and a second-turn digest returns
  only the first tool call. The harness correctly fails its exact client-call-set
  assertion before a continuation can be qualified. With the current non-stream
  per-assistant-fragment suppression, the mapping is already evicted. Repairing
  missing JSON tool-call forwarding is separate from this checkpoint guard.
- The focused mocked-SDK tests supply a full parallel assistant and hidden
  second-turn `result:success` on both response paths, so both normal completion
  guards are covered even where CLI fragmentation prevents the exact JSON shape.
- `--deferred --calls=1` safely retains and resumes in SSE mode; adding
  `--non-stream` already evicts and safely replays. Both are retained as harness
  controls, not grounds for broad single-call eviction.

### H3 — NOT REPRODUCED / disabled in production

Read-only inspection of `systemctl --user cat meridian.service`, its drop-in,
selected routing/config fields from the running MainPID's environment,
`~/.config/meridian/` JSON configuration and the installed package showed:

- ExecStart is `/usr/bin/node %h/.npm-global/bin/meridian`.
- Live `MERIDIAN_ROUTING`, `MERIDIAN_CONFIG_DIR`, and `XDG_CONFIG_HOME` are unset.
- `~/.config/meridian/settings.json` has no routing setting; none of the inspected
  config JSON has a priority/durable routing override.
- Installed `dist/cli-q1xvteq1.js` selects
  `getRoutingMode(process.env.MERIDIAN_ROUTING ?? getSetting("routing"))`.
  Installed `dist/cli-9d6ahkw8.js:getRoutingMode` defaults to `active`;
  `isPoolRouting` admits only `priority` and `active+priority`.
- Installed settings/config loading uses `MERIDIAN_CONFIG_DIR` or
  `~/.config/meridian`, so the inspected settings are the effective source.

Priority publication is therefore not enabled. No priority runtime test was run,
as requested. This does not establish safety if the operator later enables it.

## Focused suite and controls

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts --timeout 30000
npm run typecheck
```

Final focused assertions against baseline: **187 pass, 7 fail**, 194 tests.
The six new cases fail because the rejected parallel mapping was retained:
SSE mixed cap recovery (including recovery disabled), SSE normal deferred
completion (mixed/all-rejected), JSON normal deferred completion
(mixed/all-rejected). The seventh is the existing undeclared mixed-call test,
now asserting safe eviction plus fresh delivery of both client results rather
than the unsafe retained mapping. Its tool-delivery assertions are unchanged.

Guarded implementation: **194 pass, 0 fail**, 1908 assertions.
Typecheck: exit 0 (`tsc --noEmit`).

Real CLI controls (each exit 0): default, `--thinking --calls=1`,
`--thinking --calls=3`, `--captured --calls=1`, `--deferred --calls=1`, and
`--deferred --calls=1 --non-stream`. Single-call captured/rejected retention
still carries native assistant/results. Three rejected calls evict and replay
all results. Each reports `liveModelCalls:0`; exact expected upstream call counts
exclude retries and unintended extra digests.

## Handoff / remaining gates

The durable executable probe is the committed offline harness; this record keeps
sanitized red/green evidence beyond local scratch logs. No mocks qualify live
model naming, prompt-cache billing, or a full Pi/OpenCode client flow.
The real-CLI JSON two-rejected-call forwarding limitation above remains open.
Independent final patch review and any integration/publication/activation belong
to the parent workflow; only a local branch commit is authorized here.
