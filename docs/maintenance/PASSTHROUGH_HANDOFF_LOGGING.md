# Recovered streaming passthrough turns are completions

Owner-fork base: `ce5bc25a1eaab10e3caf22ca32e765923656c7b3`, branch
`fix/passthrough-handoff-log`. This work does not integrate, publish, deploy,
edit the service or restart production. The concurrent JSON-forwarding branch
also edits `server.ts` and the early-stop test file in its own worktree; none
of that work is included or modified here.

## Cause and bounded change

The streaming catch emitted `upstream.failed` and `proxy.anthropic.error`
before deciding whether the capped SDK termination was a usable tool handoff
or text truncation. The non-streaming catch already deferred failure logging
until after recovery. With `maxTurns=1`, the streaming false failures are an
ordinary tool-boundary event, not evidence of a failed client turn.

The classified streaming catch now has one outcome-logging `finally`. The two
existing recovered returns mark their outcome only after finishing their
existing work. Those outcomes emit one `upstream.completed` with the normal
streaming fields plus `sdkTermination` and `recovery` (`tool_use`,
`tool_use_uncaptured`, or `max_tokens`). All other exits emit the original two
failure events once, using a snapshot of the original failure fields and
classification. In particular, failure `durationMs` is still sampled at the
old log site, not after recovery/publication work. Stderr remains attached.

No predicates, idle-streak updates, refusal recording, retry hints, telemetry
records, persistence or wire envelopes changed. Failure logs are deferred;
`upstream.idle_streak` remains at its original classification site. The
non-streaming path is untouched. This is a reversible logging-only change;
red/green HTTP coverage and the live log surface resolve the implementation
uncertainty without a separate independent review. No new product or
architecture choice was made.

## Exit audit

Line numbers below refer to the candidate `server.ts` (base sites were
8173/8203). The final log decision is at 8960-8977.

- **Client-closed return, before classification** (8165): remains outside the
  logging decision, unchanged.
- **Uncaptured-veto IIFE returns** (8325-8349): predicate veto,
  envelope_unopened, stream_closed, terminal_delta, durable_writes_revoked,
  aborted, per-block veto, undeclared_tool, untracked_block and undefined.
  These return a value, not the request. They continue through the decision.
- **Invalidation CAS-loss throw** (8433): `Shared session mapping changed
  before recovery invalidation`. The finalizer emits both original failure
  events once; existing `terminateFailedStream` handles the actual exception.
- **Publication callback returns** (8506/8534): the store mutation and stored
  value returns are callback-local, not request exits.
- **Canceled-publication throws** (8548/8550): `Shared session mapping changed
  after canceled recovery publication` and `Request canceled after recovery
  publication`. Both emit the original failure pair once.
- **Publication CAS-loss throw** (8556): `Shared session mapping changed
  before recovery publication`. Emits the original failure pair once.
- **Captured/uncaptured recovered return** (8674): emits completion with
  `tool_use`/`tool_use_uncaptured`, no failure events.
- **Capped/output-token truncation return** (8817): emits completion with
  `max_tokens`, no failure events. Existing truncation diagnostic, telemetry
  and `passthrough.capped_turn_truncated` stay intact, including the existing
  output-token-cap case of this branch.
- **Ordinary error-frame fallthrough**: emits both failure events once,
  including max-turns with no usable content, process exits and rate-limit
  refusals. There is no separate request-level retry/failover return/throw
  between classification and the error frame in this revision. The profile
  routing wrapper may subsequently consume the refused response; its
  classified attempt still has the failure pair.
- **Implicit throws/rejected awaits**: `evictSession`, managed-fork validation
  and commit, durable-write assertions, pinned-transcript publication, store
  callbacks, canceled-publication eviction, priority readiness/finalization,
  diagnostics/telemetry and envelope work all remain inside the finalizer.
  If they exit before a recovered return, they emit the original failure
  pair. `assertDurableWritesAllowed` can throw for revoked/canceled writes;
  priority finalization can throw for missing, revoked or changed atomic
  publication. The existing outer stream cleanup still runs. The locally
  swallowed controller-close errors remain swallowed, as before.

## HTTP regression evidence

Existing mocked SDK and `mockLogObserver` in
`src/__tests__/passthrough-early-stop-integration.test.ts` were reused; no
logger seam or dependency was added.

```sh
bun test src/__tests__/passthrough-early-stop-integration.test.ts \
  --test-name-pattern 'stream termination logging'
```

| Case | Unchanged ce5bc25a | Candidate |
| --- | --- | --- |
| Captured max-turns handoff | FAIL: failure event present | PASS: one completion, tool_use/max_turns |
| Uncaptured CLI-rejected handoff | FAIL: failure event present | PASS: one completion, tool_use_uncaptured/max_turns |
| Text truncation at max-turns | FAIL: failure event present | PASS: one completion, max_tokens/max_turns |
| Empty max-turns error frame | PASS | PASS: each failure event once |
| Mid-stream process exit 2 plus stderr | PASS | PASS: each failure event once, original error/stderr |
| Rate-limit refusal | PASS | PASS: each failure event once, rate_limit_error |
| Recovery publication conflict | PASS | PASS: each original failure event once; no completion |

Baseline: exit **1**, **4 pass / 3 fail**. Candidate targeted run: exit **0**,
**7 pass / 0 fail**, 52 assertions. Final full runner includes all seven as
passing and the complete early-stop suite at **232 pass / 0 fail**. Existing
non-streaming, mapping-loss/cancellation, idle and stream-failure controls stay
green.

## Live actual-provider evidence (2026-11-15 UTC)

Tuple: Linux x86_64, Node v22.23.4, Pi AI 1.5.2 from
`/srv/pi/current/node_modules/@earendil-works/pi-ai`, Agent SDK 0.2.141,
Claude Code 2.1.322 from the production executable preference, requested and
native-pinned `claude-haiku-5-5`. This uses the installed provider's real
`stream` and `normalizeContext`, not a Pi session or a mocked client.

Before either server started, production MainPID was read as **2333482** and
its state overrides were checked read-only. The isolation method is the one
in `scripts/e2e-signal-exit.mjs`: per-case HOME, XDG paths, native config,
Meridian config, session root, GC/turn/process locks, bookkeeping directory,
telemetry DB, workdir, plugin paths and TMPDIR are private. An explicit single
profile contains an access-only read-only credential snapshot; no refresh
credential or production settings/store are copied. JSON bookkeeping is
explicit (also production's default). Source-path checks are retained in
`isolation.md`, `state-path-search.txt` and `absolute-state-search.txt` in the
evidence directory. No writable global path was found; machine-id and proc
identity reads are read-only host inputs. Fresh loopback ports must bind and
must not be 3456. Only each owned server ChildProcess receives SIGTERM after
its response finishes. Both mains joined with exit 0, with zero observed
remaining descendants; private credentials/state were removed.

Three live calls total. The first baseline control accidentally retained the
model's `supportsMidConvoToolChanges` compatibility flag. Pi added its hidden
`__pi_deferred_placeholder__`, Meridian lifted the budget and used ordinary
completion. That call did **not** prove the regression and its failed harness
assertion is retained under `initial-deferred-*`. For the red/green pair,
provider model compatibility explicitly disables mid-conversation tool/system
changes and message threads. The outgoing request asserts exactly one
`handoff_probe` tool with no deferral; the real provider still creates and
consumes the request. Both calls ask the tool to return the fixture marker.

| Build | Scratch main / port | Pi result | Log outcome |
| --- | --- | --- | --- |
| ce5bc25a source archive | 4179243 / 34347 | HTTP 200, toolUse, one handoff_probe with marker=handoff-log-fixture | upstream.failed + proxy.anthropic.error |
| Candidate | 4180954 / 44139 | Same result (independent generated call ID) | one upstream.completed, recovery=tool_use, sdkTermination=max_turns |

Both SSE bodies end with `stop_reason: tool_use` and `message_stop`, without
an error frame. Both journal-style captures show
`passthrough.checkpoint_persisted`. Decisive excerpts, shortened only to omit
repeated context:

```json
{"requestId":"handoff-log-baseline-live","event":"upstream.failed","mode":"stream","model":"haiku","error":"Claude Code returned an error result: Reached maximum number of turns (1)\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.","stderr":"Warning: Custom betas are only available for API key users. Ignoring provided betas."}
{"requestId":"handoff-log-baseline-live","event":"proxy.anthropic.error","classified":"api_error"}
{"requestId":"handoff-log-fixed-live","event":"upstream.completed","mode":"stream","model":"haiku","durationMs":4144,"streamEventsSeen":8,"eventsForwarded":7,"textEventsForwarded":0,"sdkTermination":"max_turns","recovery":"tool_use"}
```

### Reproduction and retained evidence

Evidence root: `/mnt/ai-scratch/meridian-handoff-log/evidence/`.
The exact sanitized controller is `live-handoff.mjs`, SHA-256
`e5739fd5130a942f8483cfc15d0e33e7d5dae6d1caa91844bb9bc06848fdb3ff`.
It is an evidence artifact, not a committed new harness: this changes only
logging, not critical persistence, recovery or wire behavior. The procedure
and bounded receipts are durable in this document.

Build a ce5bc25a source archive and the candidate separately with the same
reflink-copied dependencies; do not build or run from production's checkout.
Check all state paths against the isolation record before starting anything.
Use a fresh private scratch root, put the matching preflight in
`evidence/isolation.md`, then:

```sh
E2E_ALLOW_LIVE_MODEL=1 \
E2E_BASELINE_ROOT=/absolute/built/ce5bc25a \
E2E_MERIDIAN_ROOT=/absolute/built/candidate \
E2E_PI_AI_ROOT=/srv/pi/current/node_modules/@earendil-works/pi-ai \
E2E_CLAUDE_BIN=/absolute/native/claude \
E2E_CREDENTIALS_FILE=/private/active-profile/.credentials.json \
E2E_SCRATCH_ROOT=/absolute/fresh/scratch \
node /path/to/retained/live-handoff.mjs
```

`live.log`/`live.exit`: exit **0**, `PASS two live tool handoffs, baseline
failure logs / fixed completion log; zero owned residuals`.
`report.json`, `baseline-live.server.log`, `fixed-live.server.log`, and their
`.sse` files retain the provider results and complete log/wire witnesses.
The two live rows exercise captured recovery; uncaptured recovery and text
truncation are HTTP-mock evidence, not claimed live qualifications.

## Final local gates

- `env -u TMPDIR npm test`: exit **0**. First process: **8260 pass, 28 skip,
  0 fail**, `Ran 8288 tests across 488 files. [537.08s]`; all isolated
  processes also pass (aggregate **9082 pass, 28 skip, 0 fail**, 9110 tests).
  Last process: **22 pass, 0 fail**. Full log `npm-test.log`.
- `npm run typecheck`: exit **0**, `tsc --noEmit`, no diagnostics;
  `typecheck.log`.
- `npm run build`: exit **0**, `fix-bun-exports: patched 2 file(s)` and
  `Certified local build 1`; `build.log`. Baseline archive build also exit
  **0**, `Built source archive without local Git provenance`;
  `baseline-build.log`.
- `git diff --check`: exit **0**.

The first full runner invocation was terminated at the tool's 600-second
limit, after reaching later isolated suites. Its partial log is retained as
`npm-test-timeout.log`; it is not counted as a passed gate. A fresh full run
with a longer timeout produced the final passing receipt above. All npm tests
used default TMPDIR, never the scratch volume override. Build and live scratch
state were removed after verification; only cited evidence remains.
