# Modified-history loop — client-history diagnosis (2026-11-13)

Status: **blocked on client-side remediation; no Meridian runtime fix**. Local
branch `fix/modified-history-loop`, runtime/source base
`096780ff1370b19ac84985be095a8d59d5820ce5`. The task explicitly requires stopping
rather than patching Meridian around a Pi-side history mutation. This commit
retains diagnostic tests and an offline reproducer, not a claim that production
replay/billing is fixed. No push, build/install, service operation, request to the
installed service, actual Pi session, or live model call was performed.

## Root cause: the stored slot was a user message, not the returned assistant

`src/proxy/server.ts:2585-2586` takes Pi's request messages unchanged as lineage
(Pi has no `canonicalizeMessagesForLineage` implementation). The recovered
checkpoint publication at `server.ts:8420-8422` passes **lineageMessages**, not
the outgoing assistant, to `storeSession`. `src/proxy/session/cache.ts:654-667`
hashes those input messages and stores their count. The assistant UUID and
forwarded tool IDs are separate checkpoint metadata. A newly returned assistant
has no message-hash slot until it appears in a later client request.

The operator-named journal excerpt and the actual user-service journal were
read. Counting the request-line shapes gives this zero-based evidence:

| Time (PST), request prefix | Count | Last four message slots |
| --- | ---: | --- |
| 13:59:52, `8d4972b3` | 61 | 57 assistant[thinking,text,tool_use]; 58 user[tool_result]; **59 user[string]; 60 user[text]** |
| 14:00:17, `5e521639` | 63 | **59 assistant[thinking,tool_use]; 60 user[tool_result]**; 61 user[string]; 62 user[text] |
| 14:00:44, `21356bea` | 65 | **61 assistant[thinking,tool_use,tool_use]; 62 user[tool_result,tool_result]**; 63 user[string]; 64 user[text] |

The first turn published its checkpoint at 14:00:12.778. The next request logs:

```text
prefix overlap 59/61, incoming 63 msgs
first mismatch at index 59: stored=afaa91326a30 incoming=228c6d2f31ae
incoming now assistant[thinking,tool_use], stored 1 blocks -> incoming 1 blocks (rewritten)
```

The following request similarly logs overlap `61/63` and
`stored=afaa91326a30 incoming=a8eb0d034c33`. Thus the repeated stored digest
belongs to the previous requests' trailing **user[string]** slots, first at 59
and then at 61. It is not a stale assistant digest or an incompletely captured
parallel batch. The client request path removes/moves that two-user suffix,
appends the returned assistant and tool results, then supplies a suffix again.
An unchanged normalized user payload repeated in that suffix repeats its hash
at a new index. Other successive digest pairs in the supplied trace are
`f1ec1da49251`, `1b2bed7089da`, and `e67d3d6f68be`.

The log's `incoming now assistant` describes **only the incoming side**;
`lineage.ts:315-317` explicitly says stored shapes are not retained. Likewise,
`stored 1 blocks` is not evidence of one stored tool call: a user string hashes
as one text block. Thinking/signatures already contribute no lineage blocks
(`src/proxy/messages.ts:18-37`), explaining why incoming thinking + N calls has
N hashable blocks.

This is a real changed request prefix. The `modified-history` decision at
`src/proxy/session/lineage.ts:839-856` is correct. Ignoring these mismatches or
pretending a stored request contained the later assistant would weaken safety.
The journal does not expose the suffix contents or name the Pi extension/hook
that injected them. No claim is made about that injector's identity, nor that
Pi rewrote the assistant's tool names, IDs, inputs or signature. The proven
mutation is the request-only user suffix, not the assistant response.

## Tests and hypothesis results

Four HTTP integration cases in
`src/__tests__/passthrough-early-stop-integration.test.ts` cover thinking + one
or three tool calls, each for three turns, with/without a transient two-user
suffix. They reconstruct the assistant from the **actual emitted SSE**, including
thinking/signature deltas, client-visible tool-name mapping and JSON input.
They verify the persisted hashes equal the input request hashes, the tool-use
terminal, fresh replay then native resume for stable history, and divergence
on a genuine edit of an earlier assistant message.

- **Stable history:** both N=1 and N=3 are continuation on unchanged base;
  later HTTP turns actually set SDK `resume` to the prior mapped session.
- **Transient suffix:** both reproduce `stored count - 2`, one stored block,
  N incoming blocks, the repeated stored digest at increasing indexes, and
  three consecutive fresh replays, even with an exact SSE assistant echo.
- **Capture/name/signature/stale-response hypotheses:** unnecessary to produce
  this failure and contradicted by the identified stored user slot. Stable
  round trips pass even when SDK metadata is fragmented per call and tool
  names change from `mcp__oc__read` to client-visible `read`.

### Sensitivity, not a fabricated red/green fix

On runtime/source base `096780ff`, temporarily requiring `continuation` in the
transient-suffix cases yields **0 pass, 2 fail**, both with:

```text
Expected: "continuation"
Received: "diverged"
```

Restoring their correct diagnostic expectation yields green. The stable-history
cases are green on base already. There is **no red-on-base/green-runtime-fix
claim**: a Meridian fix for the reported mechanism would be the wrong fix.
No production source, lineage tolerance, configuration or dependency changed.

Final focused commands:

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts --timeout 30000
# 187 pass, 0 fail, 1804 assertions
bun test src/__tests__/lineage-*.test.ts src/__tests__/session-lineage.test.ts \
  src/__tests__/passthrough-early-stop.test.ts src/__tests__/passthrough-denial.test.ts --timeout 30000
# 265 pass, 0 fail, 1123 assertions, 12 files
npm run typecheck
# exit 0
```

### Full suite and base comparison

Executed the repository's `package.json` test script's Bun commands in order,
continuing its separate-process batches despite the known main-batch failure.
The main 489-file batch: **8237 pass, 28 skip, 1 fail**, 8266 tests. Failure:
`store-mutation-baseline.test.ts:116`, `matches actual legacy mutation
durability/order, rather than the one-sync comparison` (extra `unlink:data`
trace events). This batch is **unchanged base 096780ff by construction**:
the only modified test file is explicitly excluded from that batch, and no
runtime source or other test file differs from HEAD. It independently confirms
the reported pre-existing failure; it is not blamed on this diagnostic patch.

The remaining 29 package-script commands: **764 pass, 0 fail**. Combined:
**9001 pass, 28 skip, 1 pre-existing fail**. An outer 600-second runner deadline
interrupted the first attempt in the models-auth-status batch; commands 13-30
were rerun. A 120-second outer limit interrupted priority-routing; the identical
file was rerun with sufficient time and passed **123/123** in 170.94 seconds.
No timed-out attempt was counted as a pass. `git diff --check` is clean.
Build was not run, as explicitly prohibited by the task.

## Native offline SDK/CLI evidence and a separate residual bug

The maintained `scripts/e2e-offline-fresh-checkpoint.mjs` now accepts
`--thinking`, `--calls=1|2|3`, and `--transient-tail`, assembles the exact returned
assistant from SSE, checks request-hash ownership and classifies the next
history before submitting it. It retains strict assertions on the actual
upstream assistant/results. All runs use Linux x64, Bun 1.3.14, SDK 0.2.141,
Claude Code **2.1.322**, dummy credentials, isolated state and a scripted
loopback upstream. No actual Pi client or live provider/model is involved.

```sh
bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322 --thinking --calls=1
# PASS fresh; PASS lineage: exact streamed assistant plus client results is continuation
# PASS continuation; exactly 2 upstream calls, 0 live model calls

bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322 --thinking --calls=3 --transient-tail
# PASS diagnostic: incoming assistant replaces a stored transient USER slot at count - 2
# Stale session ... prefix overlap 5/7, incoming 9 msgs
# stored 1 blocks -> incoming 3 blocks (rewritten)
# PASS diagnostic: transient suffix reproduces fresh replay; no assistant rewriting
# exactly 2 upstream calls, 0 live model calls
```

**Retained negative evidence:** `--thinking --calls=3` without a suffix passes
checkpoint persistence and `lineage.type === continuation`, but fails later:

```text
PASS lineage: exact streamed assistant plus client results is continuation
AssertionError: resumed upstream lacks real client result for toolu_offline
```

The actual second upstream request still contains CLI rejection/missing-result
entries instead of the real parallel client results. This is a distinct
multi-call canonical-rejection checkpoint problem on base, not the reported
`modified-history` loop. It means the mocked N>1 lineage success is **not** proof
of native parallel-result delivery. The assertion remains strict and failing;
no green rerun hides it. Its source-level root cause/remediation is not claimed
here and requires a separate task.

## Handoff, decisions and remaining gates

- No genuinely new product/architecture choice. Reused the existing HTTP test
  seam, lineage verifier, SSE parser and offline native harness.
- Client-side suffix remediation is out of the approved Meridian scope. Preserve
  already-sent ancestry at its source; identify the actual injector from a
  sanitized client-wire capture before changing it. This diagnosis does not
  authorize Pi core/extension changes.
- The native parallel canonical-rejection result-delivery failure remains open.
- Actual affected Pi/model acceptance, cache billing improvement, production
  activation and independent cross-vendor review are **not established**.
  No review/advisor tool is exposed to this engineer; parent/operator review
  remains a gate, not an invented pass.
- The working tree retains only this task's diagnostic/evidence changes. Other
  worktrees and the user's untracked main-checkout `.pi/` contents are untouched.
