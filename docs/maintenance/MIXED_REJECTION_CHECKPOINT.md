# Mixed and multi-turn rejected checkpoint evidence

## Cache-prefix regression: first-fragment hybrid continuation (2026-11-14 incident)

**Current policy; supersedes the all-multi-call replay conclusions below only
for proven all-captured streamed batches.** Local implementation on
`fix/multicall-resume-cache`, based on `fork/main` **bc7570dd**. No push, merge,
PR, install, service action, live-cache write or live model call. The separate
`fix/json-refused-forwarding` worktree is untouched; it overlaps this harness,
HTTP tests and `server.ts`, so the parent must reconcile both lines of work.

### Production motivation and version witness

Read-only sources: `/mnt/ai-scratch/meridian-cache-diag/journal.txt` and
`req.json`, after 13:59:46 PST. Independently recomputed from the digest:
**143 new-lineage requests with usage, 139 writing >=100k tokens, 37,302,295
cache-write tokens**. The **2269 continuation requests** had a weighted cache
read fraction of **99.4452%** (`read/(read+write)`, rounded journal values).
The parent's 81/81 captured multi-call evictions explain repeated full-history
rewrites, not a provider cache failure. Example `06ad8ea0-7335-4ae2-9579-fce71df744d4`
paid ~353k write tokens after retaining only the ~63k system/tools prefix.
These are measured pre-fix token costs, not a dollar estimate or a claim of
post-install savings.

The current service is PID **529723**, unchanged through verification.
Journal line **31845** is that PID's startup witness:

```text
2026-11-14T20:10:46-08:00 ... node[529723]: Claude executable: /home/ras/.local/share/claude/versions/2.1.322 (resolved via custom)
```

The same version appears at the original 13:59 install (line 7764) and the
17:10 restart (line 21355). Observed running CLI children at task entry also
used this exact executable. `/home/ras/.local/bin/claude` still resolves to it.
All probes below use real **CLI 2.1.322**, **Agent SDK 0.2.141**, Bun 1.3.14,
Linux x64, loopback scripted upstream and disposable state under
`/mnt/ai-scratch/meridian-multicall-cache/`. No provider traffic is involved.

### Design and scope

Design A passed; Design B was unnecessary. Track the first single-tool
assistant fragment separately from the unchanged final/undo UUID. Freeze the
first UUID only when every streamed call is settled and captured, then apply
the usual canonical, exact-client-batch publication guard. A new optional
internal `passthroughNativeToolCallId` marker distinguishes this proof from
legacy last-fragment checkpoints. JSON and SQLite mapping history, cache
reconstruction, normal/priority publication and checkpoint clearing preserve
that distinction; no SQL schema or public API change is needed.

On the next complete-result continuation, send exactly one SDK user input:
the first call's native result, then each later call and its real result in
the **existing fresh-replay record format**, then queued ordinary user
content. No new system instruction or tools change is introduced. Registered
MCP names are rendered by the existing tool-name renderer. Images and other
structured result payloads stay structured, and `is_error` stays attributed.
The existing system prompt already explains that these are completed
client-side steps. No client-visible calls are suppressed or repeated. A consolidated hybrid
assistant has no complete native undo boundary: publish a null rollback UUID
for that client slot, rather than preserving the discarded last-fragment
UUID. The new HTTP tests prove that editing its results safely replays on
undo; older ordinary undo boundaries and single-call undo are unchanged.

**Covered:** ordinary streamed all-captured multi-call completion and its
canonical one-turn `max_turns` drain recovery; deferred/PostToolBatch normal
streamed completion. Both two-/three-call batches and repeated multi→multi→
single sequences are verified against the real CLI.

**Unchanged:** single-call retention and its canonical single name-dispatch
exception; mixed/uncaptured replay; JSON multi-call replay; assistant-only /
unstreamed-SSE multi-call replay; silent-turn-recovery multi-call replay;
legacy multi-call mappings without the marker; invalid, partial, duplicate or
mismatched result-set replay. A missing, ambiguous, grouped-multiple-tool first
fragment cannot prove the singleton rewind shape and fails closed to replay.
Real CLI 2.1.322 produces the singleton per-tool fragments in every qualified
probe. Last-fragment native multi-call resume is **not** restored or qualified;
the earlier four failed probes and unknown CLI-internal cause remain valid.

### RED before the fix

The harness was extended before production source edits. From this worktree,
`--source-root` loads unchanged tracked sources from the primary checkout at
bc7570dd (its only dirt was unrelated untracked `.pi/`). It never writes there:

```sh
export MERIDIAN_E2E_SCRATCH=/mnt/ai-scratch/meridian-multicall-cache
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --source-root=/srv/dev/ai/meridian --captured --calls=2 --wire=$MERIDIAN_E2E_SCRATCH/red-2-wire.json
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --source-root=/srv/dev/ai/meridian --captured --calls=3 --wire=$MERIDIAN_E2E_SCRATCH/red-3-wire.json
```

Both exit **1**, with the same decisive output (client counts 2 and 3):

```text
SHAPE ... "captured":true,..."checkpointRetained":false,"firstRequestCalls":1
CLIENT_CALLS {"upstream":2,"expected":2,"received":2}
AssertionError: R1: upstream message prefix changed
```

The HTTP regression was also added first:

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts --test-name-pattern 'hybrid.*checkpoint resumes'
# exit 1: 0 pass / 2 fail / 232 filtered; expected original SDK session UUID, received undefined
```

### GREEN: exact content prefix and real results

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=2
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=3
# each exit 0, 2 upstream requests, liveModelCalls:0
```

```text
SHAPE ... "captured":true,..."checkpointRetained":true,"firstRequestCalls":1
PASS lineage: exact streamed assistant plus client results is continuation
PASS R1: system, tools and messages retain the complete upstream prefix
RESUME_RESULTS {"real":["toolu_offline"],"internalError":[]}
PASS hybrid continuation: first native result plus completed-call records; every real result exactly once
```

Only call 1 is native. Later real results are asserted separately in their
completed-call records, exactly once each, with no orphan native assistant
calls, placeholders, InputValidationError or CLI refusal. The full system,
tools and previous messages are compared, not just the system/tools prefix.
**Representation caveat:** CLI 2.1.322 changes its environment message's
`content` from a singleton marked text-block array to a string when moving
its cache marker. The bytes of that text are unchanged (also true for the
single-call control). The checker removes `cache_control` and canonicalizes
only string vs text-block content representation. It does not normalize text,
ignore environment content or claim byte-identical raw JSON. A demand for
literal JSON equality beyond identical prompt content is not met by this CLI.

Follow-on commands (each exit **0**, **four** upstream requests, no retry):

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=2 --follow-on
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=3 --thinking --follow-on
```

```text
PASS follow-on R1/R2: settled 2 calls; existing prefix unchanged; every real result exactly once
PASS follow-on R1/R2: settled 1 calls; existing prefix unchanged; every real result exactly once
# three-call command prints "settled 3 calls", then "settled 1 calls"
```

Every follow-up compares against the **immediately previous complete upstream
request**, including prior native results and hybrid records. Telemetry must
mark every follow-up resumed. Distinct IDs/results ensure prior results remain
exactly once, too. Exact sanitized wire bodies and commands are retained in
`matrix-*-wire.json`, `matrix-*.log` and `matrix-results.json` under the evidence
root; RED bodies/logs are `red-{2,3}-wire.json` and `red-{2,3}.log`.

### Exact three-call follow-up user message

From the real upstream capture for the three-call row, including the CLI's
final cache marker. These are the complete text blocks the model sees for
calls 2 and 3; the renderer adds no summary or paraphrase of their results:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_offline",
      "content": "REAL_CLIENT_RESULT[toolu_offline]"
    },
    {
      "type": "text",
      "text": "[Assistant: Previously called tool: {\"id\":\"toolu_offline_1\",\"name\":\"mcp__oc__read\",\"input\":{\"file_path\":\"new-1\"}}]"
    },
    {
      "type": "text",
      "text": "Recorded tool result: {\"tool_use_id\":\"toolu_offline_1\",\"is_error\":false}"
    },
    {
      "type": "text",
      "text": "REAL_CLIENT_RESULT[toolu_offline_1]"
    },
    {
      "type": "text",
      "text": "[Assistant: Previously called tool: {\"id\":\"toolu_offline_2\",\"name\":\"mcp__oc__read\",\"input\":{\"file_path\":\"new-2\"}}]"
    },
    {
      "type": "text",
      "text": "Recorded tool result: {\"tool_use_id\":\"toolu_offline_2\",\"is_error\":false}"
    },
    {
      "type": "text",
      "text": "REAL_CLIENT_RESULT[toolu_offline_2]",
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ]
}
```

### Final offline matrix and local gates

All original 19 rows below were rerun on final source; only the three
all-captured **streamed** multi-call rows change from eviction to retention.
The five extra rows protect JSON replay and prove deferred and follow-on
continuations. **24 pass / 0 fail**, all exit **0**, all `liveModelCalls:0`.
Each command shares the GREEN CLI prefix above:

| Arguments | Exit | Upstream requests | Checkpoint |
|---|---:|---:|---|
| default | 0 | 2 | retained |
| `--thinking --calls=1` | 0 | 2 | retained |
| `--thinking --calls=3` | 0 | 2 | evicted |
| `--mixed --calls=2` | 0 | 2 | evicted |
| `--mixed --calls=2 --input-validation` | 0 | 2 | evicted |
| `--deferred --calls=2` | 0 | 3 | evicted |
| `--deferred --calls=2 --mixed --captured-last --non-stream` | 0 | 2 | evicted |
| `--deferred --calls=1` | 0 | 3 | evicted |
| `--deferred --calls=1 --non-stream` | 0 | 3 | evicted |
| `--deferred --calls=1 --input-validation` | 0 | 3 | evicted |
| `--captured --calls=1` | 0 | 2 | retained |
| `--captured --calls=2` | 0 | 2 | retained |
| `--captured --calls=3` | 0 | 2 | retained |
| `--captured --calls=3 --sse-delay-ms=25 --distinct-tools` | 0 | 2 | retained |
| `--unstreamed --deferred --captured --calls=1` | 0 | 2 | retained |
| `--unstreamed --deferred --captured --calls=2` | 0 | 2 | evicted |
| `--unstreamed --deferred --captured --calls=3` | 0 | 2 | evicted |
| `--unstreamed --deferred --mixed --calls=2` | 0 | 2 | evicted |
| `--unstreamed --deferred --mixed --calls=2 --captured-last` | 0 | 2 | evicted |
| `--captured --calls=2 --non-stream` | 0 | 2 | evicted |
| `--captured --calls=3 --non-stream` | 0 | 2 | evicted |
| `--captured --calls=2 --deferred` | 0 | 2 | retained |
| `--captured --calls=3 --thinking --follow-on` | 0 | 4 | retained |
| `--captured --calls=2 --follow-on` | 0 | 4 | retained |

- New HTTP tests: **2 pass / 0 fail**. Combined early-stop HTTP/pure suite:
  **319 pass / 0 fail**, 2604 assertions. Additional direct hybrid helper
  tests: **5 pass / 0 fail**, 24 assertions; cover ordering, exact literal
  result text, errors/media, missing/ambiguous echoes and publication vetoes.
- JSON/SQLite store contract: **8 pass / 0 fail**, 66 assertions, including
  hybrid migration, SQL write/read, checkpoint clearing and export. Deny-hold
  suite: **4 pass / 0 fail**, 26 assertions, including fast queued continuation
  and interleaved per-call echoes.
- `npm test`: **exit 0**, run in foreground with a 1800-second timeout.
  Across all isolated commands: **9091 pass / 28 skip / 0 fail**. Initial bulk
  command: 8265 pass / 28 skip / 0 fail, 489 files, 552.29 s; isolated HTTP
  file: 234 pass / 0 fail. Skips are the existing unavailable
  `BOOKKEEPING_COMPAT_TARBALL` old-bundle compatibility cases.
- `npm run typecheck`: **exit 0**. `npm run build`: **exit 0**;
  `Certified local build 2 (684bf7e7-7cf6-44cd-83b9-ece8f435a479)`.
- Development failures were corrected, not bypassed: two deny-hold assertions
  still demanded replay and now assert the hybrid session/first UUID and
  structured input. Final self-review also found and corrected the stale
  last-fragment undo UUID risk above before rerunning every local gate and
  the complete offline matrix. The first full run was 8263 pass / 28 skip / 2 fail;
  an intervening pretest caught TypeScript's narrowing of a reset global mock
  variable. The store test originally tried writing after completed export;
  it now validates clearing before export (runtime correctly refuses an
  exported store). Final full rerun and focused tests above are green.

Evidence logs: `npm-test-final.log`, `typecheck-final.log`, `build-final.log`,
`integration-full.log`, `store-contract.log`, `deny-hold.log`,
`red-integration.log`, `green-integration.log`, `last-focused.log` (final
whitespace-only test cleanup: exit 0, 6 pass / 0 fail, 225 assertions), and the
initial failed `npm-test.log`, plus the matrix/RED artifacts above. Relative
SPEC links and `git diff --check` also passed. This committed
record preserves before/after findings even if scratch evidence is removed.
No hooks were skipped. Independent cross-vendor review is not claimed: this
bounded engineer surface exposes no subagent/advisor/reviewer tool. The
parent owns review before landing, CI, integration and activation. UAM was
also unavailable here (`uam_status: command not found`); isolated worktree
and read-only concurrency checks are not a global all-clear.

### Separate journal finding: captured=0 and apparently single-call evictions

`captured` is the number of **PreToolUse hook captures**, not the model's or
client's complete tool-call count. After the install the journal has **121**
`reason=drain_error` evictions grouped by capture count:
**0:36, 1:4, 2:72, 3:7, 4:2**. All observed terminations are the normal
one-turn `max_turns` boundary, not evidence of an I/O drain failure.

The four `captured=1` cases are **not single-call turns**. Matching each
request's full logged history-shape prefix to its earliest subsequent
extended history gives **two tool_use blocks and two real-result slots**:

| Evicted request | Eviction journal line | Following request / line |
|---|---:|---|
| `4c81f932-b7ff-4828-a263-d21d7b50eeaf` | 9404 | `aa3eee61-7721-4fb1-a931-50d76c06e490` / 9414 |
| `0ae1043b-b0f5-4c0b-a67f-5910f2fd5391` | 14819 | `91dac9d6-f975-4448-9d64-b3f66f672c44` / 14823 |
| `168e932e-103c-4939-9a83-470cf53c5e6d` | 32163 | `ebbd5307-f914-462a-a396-ee533440bd91` / 32193 |
| `4e195e35-e255-4f23-93bf-a00c4698fd5a` | 33669 | `4bd19782-6489-4f38-a0ca-fccf1fe1a9b6` / 33679 |

Thus these are mixed two-call turns (one captured, one not), which fail both
the capture guard and the old multi-call guard. Their eviction is expected
under the retained mixed-batch safety policy, not a single-call regression.
No code was changed for this finding.

For `captured=0`, **35/36** have a matching follow-up within the extract:
**34** echo two calls/results, **one** echoes three. For example
`eb23e33a-cdac-4cde-ae8c-c03568f98584` has zero captures but its next request
`a5d9ce8c-2ca0-46e6-ab85-8a477ba93052` (line 7848) appends
`assistant[thinking,text,tool_use,tool_use] → user[tool_result,tool_result]`.
Zero capture is not zero calls: calls refused before hooks are still forwarded
to the client. They fail the ordinary capture guard, and the narrowly scoped
canonical name-dispatch exception requires exactly **one** declared call.
Their multi-call eviction is therefore expected and deliberately unchanged.
The final zero-capture case `6eca7fa0-d809-455f-ab33-ef50a6c5fdba` has no
follow-up in this extract: the journal proves its capture-less checkpoint and
max-turn recovery/eviction, but not its exact call count or CLI refusal type.
The event does not log individual guard vetoes, so a more specific cause for
that final case cannot be established from the supplied evidence alone.

These correlations use complete **shape** prefixes, not unavailable body
content or tool IDs; no transcript or live cache was read. The journal does
not identify every refusal as name-dispatch vs input validation. The durable
local analysis artifact is `journal-classification.json` in the evidence
root. This patch does not broaden either uncaptured or mixed continuation.

### Residual limits for the parent

- No live model/client test, CI, PR, merge or install was attempted (expressly
  prohibited). Offline real-CLI request bodies prove delivery and content
  prefix stability, not provider cache billing or future model obedience.
- Real CLI version scope is 2.1.322 / SDK 0.2.141. Grouped-first-fragment or
  missing-first-UUID shapes still replay rather than risk orphan results.
- SQLite's older reader rejects unknown mapping-history fields. Before a
  downgrade to bc7570dd against a SQLite store that contains hybrid markers,
  use a compatible export/migration procedure or retain a reader supporting
  the marker; do not silently run the old reader on new history. No live
  store was changed here. JSON legacy multi-call mappings already replay on
  read; rollback/export qualification itself is not claimed.

## Unstreamed SSE publication blocker (2026-11-14)

**Status: fixed and locally verified on `fix/mixed-rejection-resume`; no push,
PR, integration or activation.** Implementation commit: `fe2e389e`. This
follow-up starts at `27c03fdb` and closes its publication gap; it does not change
the approved replay policy. The running
`meridian.service`, installed main `e1c37ba4`, and live cache were not touched.
No live model calls were made. Real-CLI evidence uses Linux x64, Bun 1.3.14,
Agent SDK 0.2.141 and Claude Code 2.1.322 at the path below.

### RED: unstreamed completion really resumes and loses results

Reused the existing offline HTTP/SDK/CLI harness, tracker and publication gates;
no new transport or SDK/CLI patch. `--unstreamed` creates a disposable launcher
that **execs the named real CLI with only `--include-partial-messages` removed**.
The SDK iterator, tool hooks, PostToolBatch success, transcript persistence and
resume remain real. This forces the assistant-only output shape, not the
upstream rate-limit failure that can cause it naturally. Runtime diagnostics
assert zero SDK stream events and execution of `openUnstreamedEnvelope`:

```text
UNSTREAMED {"streamEventsSeen":0,"envelopeForwarded":true}
```

With only server.ts and passthroughEarlyStop.ts temporarily restored from
`27c03fdb`, each command below exits **1** (final harness assertions unchanged).
Python `finally` restores saved source bytes and checks
`IMPLEMENTATION_RESTORED True`; no git history or refs are rewritten.

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --deferred --unstreamed --captured --calls=2
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --deferred --unstreamed --mixed --calls=2
```

Both report `checkpointRetained:true`, continuation lineage, and
`RESUME_RESULTS {"real":[],"internalError":["toolu_offline_1"]}`, then fail
`resumed upstream lacks real client result for toolu_offline`. The captured row
emits exactly 2/2 client calls. The mixed row emits 1/1 captured client calls out
of two upstream calls: the existing assistant-only envelope does not forward
uncaptured rejected calls. The harness explicitly asserts that subset only for
`--unstreamed`; all original rows still assert the complete upstream call set.
This work fixes unsafe resume and real-result loss, not that separate forwarding
limitation. Every GREEN row checks every real result the client returned.

The HTTP regression command against the same baseline implementation:

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts --timeout 30000 --test-name-pattern 'publication guard replays SSE'
# exit 1: 0 pass, 7 fail, 48 assertions; 218 filtered out.
```

All seven reach the follow-up and fail at `options.resume` being present:
assistant-only two-captured, mixed and uncaptured completion; latch-before-drain
with late metadata, late metadata plus wire, wire-only with no assistant metadata,
and capped-error recovery. Thus the independent capture-proof advisory was
reproduced, not assumed. The wire-only row also failed against the intermediate
metadata-only fix (exit 1, 0 pass/1 fail, 7 assertions), proving the need to keep
observing raw calls even when drain suppresses their frames.

Silent-turn RED (before its write-side fix):

```sh
bun test src/__tests__/silent-turn-recovery.test.ts --timeout 30000 --test-name-pattern 'publication guard'
# exit 1: 1 pass, 2 fail, 22 assertions; 14 filtered out.
```

The one-call control retains; the two/three-call recovery rows publish unsafe
mappings. Their existing read guard already replays, but does not excuse that
write-side invariant violation.

### Shared write-side invariant and GREEN

`checkpointPublicationRequiresReplay` in `passthroughEarlyStop.ts` is the one
publication policy used by JSON completion, SSE normal completion,
captured-error recovery and silent recovery. Before a tool turn can publish:

- the candidate must have a settled assistant UUID and canonical SDK result;
- its exact ID set must equal the client-visible batch, with exactly one call;
- every observed assistant/wire call must have capture proof, including calls
  seen after latching during hidden drain. The existing canonical single-call
  name-dispatch exception supplies proof only for its one streamed ID.

JSON supplies its completed response blocks. SSE supplies the union of streamed
IDs and captured calls queued for its final envelope, so a zero-partial-events
turn cannot masquerade as plain text and publish null checkpoint metadata.
Assistant-only single-call capture can settle after canonical drain and retain a
real rewind checkpoint. Captured hidden digest metadata pruned from the client
batch does not alone make the batch multi-call. Ordinary single-call retention,
plain text resume and the canonical single-call exception remain covered.

Silent recovery applies the same policy before releasing buffered output. A
multi-call recovery wins exact-generation eviction instead of publishing its
fork; it then emits the complete captured batch and abandons the unreferenced
fork. A new CAS-race regression verifies that losing eviction withholds calls
and preserves the winning mapping. Single-call recovery still publishes and
resumes its exact fork/assistant UUID. No mapping schema or public API changed.

Focused GREEN command (also covers the old single-call, hidden-digest,
alternate-message-start, duplicate and deny-hold controls):

```sh
bun test src/__tests__/proxy-passthrough-deny-abort.test.ts src/__tests__/proxy-stream-deny-hold.test.ts src/__tests__/passthrough-early-stop-integration.test.ts src/__tests__/passthrough-early-stop.test.ts src/__tests__/silent-turn-recovery.test.ts --timeout 30000
# exit 0: 348 pass, 0 fail, 2650 assertions across 5 files.
```

The exact seven-row RED integration command is GREEN: exit 0, 7 pass, 0 fail,
62 assertions (218 filtered out). The silent command extended to include the
CAS case (`--test-name-pattern 'publication guard|replay invalidation'`) is
GREEN: exit 0, 4 pass, 0 fail, 32 assertions (14 filtered out).

A development run initially had 344 pass/1 fail: settling every otherwise
complete streamed candidate at publication broadened retention for the existing
alternate-second-message-start case. Settlement is now restricted to the
zero-stream-event assistant-only fallback; the original noncanonical streamed
case still evicts. Ten direct pure-function cases cover publication policy.

### Final real-CLI matrix: original 14 plus five unstreamed rows

Every row uses this prefix, exits **0**, reports `liveModelCalls:0`, and checks
exact client-call equality, no extra retry, every real result, and no CLI denial
or internal-error placeholder on the follow-up. The five new rows also require
the `UNSTREAMED` runtime witness above. The complete 19-row matrix passed twice;
the final run adds the explicit runtime witness, rather than treating removal
of the CLI flag alone as proof of the path.

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322
```

| Arguments | Pass/fail | Upstream requests | Client calls | Checkpoint |
|---|---|---:|---:|---|
| default | 1/0 | 2 | 1 | retained |
| `--thinking --calls=1` | 1/0 | 2 | 1 | retained |
| `--thinking --calls=3` | 1/0 | 2 | 3 | evicted |
| `--mixed --calls=2` | 1/0 | 2 | 2 | evicted |
| `--mixed --calls=2 --input-validation` | 1/0 | 2 | 2 | evicted |
| `--deferred --calls=2` | 1/0 | 3 | 2 | evicted |
| `--deferred --calls=2 --mixed --captured-last --non-stream` | 1/0 | 2 | 2 | evicted |
| `--deferred --calls=1` | 1/0 | 3 | 1 | evicted |
| `--deferred --calls=1 --non-stream` | 1/0 | 3 | 1 | evicted |
| `--deferred --calls=1 --input-validation` | 1/0 | 3 | 1 | evicted |
| `--captured --calls=1` | 1/0 | 2 | 1 | retained |
| `--captured --calls=2` | 1/0 | 2 | 2 | evicted |
| `--captured --calls=3` | 1/0 | 2 | 3 | evicted |
| `--captured --calls=3 --sse-delay-ms=25 --distinct-tools` | 1/0 | 2 | 3 | evicted |
| `--unstreamed --deferred --captured --calls=1` | 1/0 | 2 | 1 | retained |
| `--unstreamed --deferred --captured --calls=2` | 1/0 | 2 | 2 | evicted |
| `--unstreamed --deferred --captured --calls=3` | 1/0 | 2 | 3 | evicted |
| `--unstreamed --deferred --mixed --calls=2` | 1/0 | 2 | 1 of 2 upstream | evicted |
| `--unstreamed --deferred --mixed --calls=2 --captured-last` | 1/0 | 2 | 1 of 2 upstream | evicted |

**19 pass / 0 fail.** The two formerly failing real-CLI rows now report
`checkpointRetained:false` and `PASS follow-up: fresh replay, not a resumed
continuation; real client result for every call; no CLI rejection`.

### Full gates and residual boundaries

| Command | Exit | Result |
|---|---:|---|
| `npm test` (pretest typechecks) | 0 | 9056 pass, 0 fail, 28 skip, 50320 assertions across 32 isolated runs |
| `npm run typecheck` | 0 | `tsc --noEmit`, no diagnostics |
| `npm run build` | 0 | Node entrypoints checked; certified local build 3 (`34c21b4f-b987-4e1c-bef3-d52414d203fc`) |
| `git diff --check` | 0 | no whitespace errors |

The first full-suite invocation was interrupted by its 300-second command limit
before a test summary, with no reported failure; it is not counted as a pass.
Two subsequent runs with a 1200-second limit completed all 32 declared groups
(9056/0/28 each); the final run after source cleanup is tabulated above. The 28
existing skips remain the unsupplied bookkeeping compatibility fixture (27)
and Windows-only PID-reuse case (1). No hooks were skipped or test-runner
isolation changed in this follow-up.

No new product or architecture choice was made; this enforces the already
approved fresh-replay requirement. Native multi-call SDK resume remains
unqualified, fresh replay still loses SDK-only context absent from client
history, and real live-model/client acceptance remains unperformed by explicit
instruction. The real-CLI no-partial-event shape is forced by a launcher, not a
claim to have reproduced spontaneous CLI stream fallback. The latch and silent
recovery regressions are mocked-HTTP evidence, not real-CLI reachability claims.
Independent cross-vendor review of this follow-up remains with the orchestrator:
this engineer's tool surface provides no governed reviewer dispatch, and no
substitute live model call was made. No push, PR, install, live-cache write or
service operation is authorized or performed.

## Approved all-captured fallback (2026-11-14)

**Status: implemented and locally verified; not reviewed, integrated or activated.**
This section supersedes the historical all-captured retention restrictions and
stop conditions below. The operator explicitly approved diagnosis first, then
multi-call fresh replay if a Meridian-side resume repair could not be proven.
Worktree: `/srv/dev/ai/meridian-wt-mixed-rejection`; branch:
`fix/mixed-rejection-resume`; implementation starts from `c810a48b`.
No SDK/CLI package changes, live model calls, live cache writes, production
service operations, publication or integration were performed.

### Diagnosis before fallback

Linux x64, Bun 1.3.14, Agent SDK 0.2.141, actual Claude Code 2.1.322 at
`/home/ras/.local/share/claude/versions/2.1.322`. Every CLI probe uses the
committed offline HTTP harness, scripted loopback upstream and disposable state.
First reproduced both exact operator commands on unchanged c810a48b:

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=2
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322 --captured --calls=3
# Each exit 1: resumed upstream lacks real client result for toolu_offline_1
# CLIENT_CALLS expected=received=2 / 3; retained checkpoint; real=[toolu_offline].
# CLI placeholders replace call 2 / calls 2 and 3 respectively.
```

Searched the existing structured-input/coalescing, checkpoint tracking and
freeze paths, SDK resumeSessionAt declaration, and the existing offline/paced
fixture rather than building a second transport. SDK documentation requires an
assistant-message UUID. Existing notes already prove a single grouped SDK
input carries all three real results. Ranked hypotheses: input order/grouping,
rewind fragment selection, then hook settlement timing. Tested each independently
using the three-captured command above (same result/assistant assertions):

| Temporary Meridian-only probe | Exit | Observed upstream outcome |
|---|---:|---|
| Reverse structured content blocks at makePrompt | 1 | No exact real result; calls 2/3 still have placeholders |
| Split native results into one SDK user input per block | 1 | Only call 1 real; calls 2/3 still placeholders |
| Delay each forwarding denial an additional 100 ms after the existing hold | 1 | Only call 1 real; calls 2/3 still placeholders |
| Keep the first, rather than last, assistant fragment UUID | 1 | Call 1 real, but later assistant calls absent; fails assistant completeness |

All source probes restored saved bytes in Python `finally`, with
`IMPLEMENTATION_RESTORED True`. No package or transcript mutation was used.
These experiments did **not** prove the CLI-internal cause or a safe input
contract; a failed delay probe does not exclude every possible timing defect.
Therefore the approved fallback, not a speculative CLI workaround, is used.

### Implementation and coverage

`checkpointRequiresReplay` retains the existing capture-proof check and rejects
any checkpoint with more than one distinct call ID. JSON completion, SSE
completion and captured-error recovery use it before publishing mappings. A
read-side guard also replays previously retained multi-call checkpoints, so
upgrading does not leave old unsafe mappings resumable. Ordinary non-tool
resumes, single-call captured checkpoints and the canonical single-call
name-dispatch rejection exception are unchanged. JSON's independent capture
checks still cover all emitted/streamed IDs; hidden captured digest metadata
pruned from the client-visible batch does not alone force multi-call eviction.
No wire API, schema, dependency, routing or CLI behavior was changed.

New HTTP regressions cover 1/2/3 captured calls × SSE/JSON × capped-error/normal
completion (12 cases), plus two previously retained 2/3-call mapping cases.
They assert retention/eviction, resume options and exactly one occurrence of
each real result in the SDK prompt. Existing three-turn thinking, late fragment,
unstreamed recovery, OpenAI parallel, deny-hold and duplicate tests now require
safe replay where appropriate while preserving complete tool delivery checks.
The rollback-UUID test uses text plus a single tool fragment to keep exercising
the still-supported checkpoint-fork behavior. The hidden-digest/single-call
retention regression remains unchanged and passes.

Red command, with **only** server.ts and passthroughEarlyStop.ts temporarily
restored from c810a48b (finally restored byte-for-byte):

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts --timeout 30000 --test-name-pattern 'all-captured checkpoint|legacy retained'
# exit 1: 4 pass, 10 fail, 124 assertions (all four single-call controls pass).
```

Final focused command:

```sh
bun test src/__tests__/proxy-passthrough-deny-abort.test.ts src/__tests__/proxy-stream-deny-hold.test.ts src/__tests__/passthrough-early-stop-integration.test.ts src/__tests__/passthrough-early-stop.test.ts --timeout 30000
# exit 0: 313 pass, 0 fail, 2504 assertions, 4 files.
```

The earlier two-file focused command (the last two paths above) passed 293/0,
2399 assertions after adding legacy-map regressions. During development it
reported 283/8, then 291/0 before those two extra regressions; the eight failures
were obsolete parallel-retention expectations, corrected to require replay.
The first generated regression fixture had shell-expanded template literals;
it was corrected and read back before collecting the distinct-ID red evidence
(4/8, 116 assertions), then rechecked against c810a48b as recorded above.
The first expanded four-file run reported 312/1, 2498 assertions: the dropped
JSON duplicate case already evicts on c810a48b (baseline targeted command:
`bun test src/__tests__/proxy-passthrough-deny-abort.test.ts --test-name-pattern 'checkpoint retains only' --timeout 30000`, exit 1, 1 pass/1 fail, 12 assertions).
Its assertion now preserves that capture-proof behavior rather than expanding
single-call retention to an uncaptured dropped ID.

### Final offline real-CLI matrix

Command prefix for every row (each exit 0, independently checked):

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322
```

| Arguments | Pass/fail | Upstream requests | Checkpoint |
|---|---|---:|---|
| default | 1/0 | 2 | retained |
| `--thinking --calls=1` | 1/0 | 2 | retained |
| `--thinking --calls=3` | 1/0 | 2 | evicted |
| `--mixed --calls=2` | 1/0 | 2 | evicted |
| `--mixed --calls=2 --input-validation` | 1/0 | 2 | evicted |
| `--deferred --calls=2` | 1/0 | 3 | evicted |
| `--deferred --calls=2 --mixed --captured-last --non-stream` | 1/0 | 2 | evicted |
| `--deferred --calls=1` | 1/0 | 3 | evicted |
| `--deferred --calls=1 --non-stream` | 1/0 | 3 | evicted |
| `--deferred --calls=1 --input-validation` | 1/0 | 3 | evicted |
| `--captured --calls=1` | 1/0 | 2 | retained |
| `--captured --calls=2` | 1/0 | 2 | evicted |
| `--captured --calls=3` | 1/0 | 2 | evicted |
| `--captured --calls=3 --sse-delay-ms=25 --distinct-tools` | 1/0 | 2 | evicted |

**14 pass / 0 fail**, including the original 11-case matrix. All rows report
`liveModelCalls:0` and exact CLIENT_CALLS expected/received equality. Every
follow-up contains every real result; single-call retained cases still use
native assistant/results without denials. The new cases print:

```text
checkpointRetained:false
PASS follow-up: fresh replay, not a resumed continuation; real client result for every call; no CLI rejection
```

The harness changes only the expected retention policy and adds an explicit
no-internal-error-placeholder assertion. Exact client-call-set, per-result
content, native-assistant-versus-replay and no-retry assertions remain intact.
The complete matrix passed during development and again after final
source/test/runner changes, not as unexplained green retries of a red case.

### Full gates and test-runner isolation

| Command | Exit | Concrete result |
|---|---:|---|
| `npm test` (final, includes pretest `tsc --noEmit`) | 0 | 9036 pass, 0 fail, 28 skip, 50221 assertions across 32 process-isolated runs |
| `npm run typecheck` | 0 | `tsc --noEmit`, no diagnostics |
| `npm run build` | 0 | Node entrypoints bundled; `Certified local build 2 (216c157b-1e3b-406d-9d3c-b2879cabd5ff)` |
| `git diff --check` | 0 | no whitespace errors |

The 28 existing skips are 27 compatibility cases requiring the unsupplied
BOOKKEEPING_COMPAT_TARBALL and one Windows-only PID-reuse recovery case on Linux;
no coverage is claimed for those skipped cases. Earlier typecheck/build invocations
also exited 0 (build 1 was an intermediate local bundle, not installed).

The first `npm test` exited 1: 8235 pass, 6 fail, 28 skip, 44877 assertions.
Five failures asserted obsolete/baseline parallel or dropped-duplicate retention;
the sixth was a process-global filesystem-spy collision in store-mutation-baseline.
That collision reproduces with unchanged c810a48b implementation using
`bun test src/__tests__/sticky-routing-integration.test.ts src/__tests__/store-mutation-baseline.test.ts --timeout 30000`
(exit 1, 7 pass/1 fail, 31 assertions). The store file alone passes
`bun test src/__tests__/store-mutation-baseline.test.ts --timeout 30000`
(exit 0, 3 pass/0 fail, 17 assertions). Its warm mutation trace sees unrelated
session lifecycle `sync:data`, `link:data->data`, `unlink:data` operations after
proxy initialization. It now runs separately using the existing package.json
process-isolation recipe; no assertions were removed or skipped.

The second `npm test` exited 1: 8237 pass, 1 fail, 28 skip, 44888 assertions.
The bookkeeping-runtime offline migration case found a live **same-process**
`session-gc.json.lock.candidate` while mixed with proxy tests. Its isolated run
`bun test src/__tests__/bookkeeping-runtime.test.ts --timeout 30000` passed
10/0, 45 assertions; a baseline sticky-routing pair passed 15/0, 60 assertions
(`bun test src/__tests__/sticky-routing-integration.test.ts src/__tests__/bookkeeping-runtime.test.ts --timeout 30000`, exit 0).
The narrower current-source command
`bun test src/__tests__/proxy-error-handling.test.ts src/__tests__/settings-unit.test.ts src/__tests__/passthrough-input-coercion.test.ts src/__tests__/bookkeeping-runtime.test.ts --timeout 30000`
passed 54/0, 191 assertions, exit 0. Thus the full-suite collision is not
reliably reproduced by those narrower combinations. The runtime file now also
runs in its own process, preventing earlier proxy jobs from entering its
explicit offline migration fixture. This is test isolation, **not** a fix for
any production session-GC lock defect; that separate worker's implementation
and worktree were not touched. With both files isolated, the entire declared
npm test chain, including all downstream groups previously short-circuited by
failures, passes. Root production-lock diagnosis remains with the parent/worker.

### Cache cost and remaining limits

Using only the operator's supplied production rates, not a fresh journal query:
64–66 two-call plus 7–9 three-call captured checkpoints/day yields **71–75
newly replay-eligible follow-ups/day**, if every checkpoint receives a follow-up
(2130–2250 over 30 days at that rate). Each loses one opportunity to resume its
old SDK prefix; it does not add an extra model request in the offline cases.
If the replayed prefix averages P2/P3 tokens for two-/three-call turns, the
prefix rebuilt per day is approximately `(64–66)*P2 + (7–9)*P3` tokens, or
`(71–75)*P` for a common average P. These are candidate prefix-rebuild tokens,
not measured cache misses: actual caching may reuse some replay prefixes.
There are no production prefix-token sizes, cache-read/write usage or measured
billing deltas in this brief, so a dollar estimate or percentage cache drop
would be invented. Single-call capture keeps its existing cache benefit.

No new product/architecture choice was made: this applies the explicitly
approved fallback. Exact CLI-internal cause remains undetermined; native
multi-call resume is not repaired or qualified. Full replay cannot restore
SDK-only thinking absent from client history and still follows existing replay
budgeting. The separate real-CLI JSON parallel forwarding and absent-boundary
reachability limits described below are not repaired. Cross-vendor review,
actual live-model/client acceptance, integration and activation remain with the
parent; live calls and production changes were explicitly prohibited here.
Temporary local logs are summarized here and removed at handoff; no test units
or other long-lived processes were started.

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
