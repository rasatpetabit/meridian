# Mixed and multi-turn rejected checkpoint evidence

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
