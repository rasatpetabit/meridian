# Signal-stopped Claude Code requests and shutdown drain

Local change based on `8ea701d13179f04cadd8fe1eb26b720b66200325`, branch
`fix/signal-exit-transient`. No integration, publication, deployment, unit edit
or service restart is part of this work.

## Scope and behavior

The operator established the cause: systemd's control-group SIGTERM reaches
Claude children at the same time as Meridian, defeating the existing drain.
The separate service-owner proposal is `KillMode=mixed`; this patch changes no
service configuration. It makes SDK exits 143/137 transient 503 `api_error`
responses before the SDK-crash branch's own stderr/login heuristics, preserving
all earlier global classification precedence and all other exit codes.

SDK 0.2.141 also reports `Claude Code process terminated by signal SIGTERM`
(or SIGKILL) when its exit code is null. Previously that string reached the
classifier's default 500 with the raw text. It now uses the same transient
503 wording naming the signal. Other signals retain their previous behavior.

No shutdown-path code changed. In `startProxyServer.close()`, grace expiry calls
`forceAbortInFlight()` and `connectionTracker.forceCloseAll()` synchronously.
The latter destroys sockets before asynchronous request error handling can send
an SSE envelope. The actual client result below confirms this. New requests
while draining already receive 503 `overloaded_error` with the drain message.
503 `api_error` does not trigger account failover.

## Regression tests

Run:

```sh
bun test src/__tests__/errors.test.ts \
  src/__tests__/cli-model-error-boundaries.test.ts \
  src/__tests__/proxy-stream-error-recovery.test.ts
```

Tests added before changing production code: **258 pass, 9 fail**, exit 1.
After the fix: **267 pass, 0 fail**, exit 0 (604 assertions).
The nine newly red cases are six numeric-exit cases (143/137, each bare,
non-auth stderr, and stderr containing `oauth` but not a global auth signal),
two null-code signals, and the streamed crash SSE message assertion.
Global `authentication` precedence, other signals, generic code 2, and existing
code-1/no-stderr coverage remain green on both versions.

Exactly two old-behavior fixtures changed:

- `errors.test.ts`, generic numeric exit parsing: 137 -> 2, including the
  message's expected code; still expects 502 `api_error`.
- `cli-model-error-boundaries.test.ts`, unrelated error preservation: 137 -> 2;
  still expects 502, outside model-version refusal classification.

`extractSdkTermination` parsing tests were not changed. No other old signal-exit
classification pins were found.

## Isolation before any server start

Production MainPID was read-only queried as 3498246. Its HOME is `/home/ras`;
there were no config/session/Claude directory environment overrides. The
scratch servers received a minimal explicit environment rather than inheriting
production settings. Each had its own HOME, XDG paths, TMPDIR, Meridian config,
telemetry SQLite DB, session directory, workdir, plugin paths and Claude config.
One explicit profile borrowed an **access-only**, read-only snapshot from the
already-active work profile; no refresh token was copied and no account switch
or credential refresh was attempted.

The source boundary is `configDir.ts`, `sessionStore.ts:getSessionStoreDir`,
`sessionLifecycle.ts:getStoreDir/withSidecarLock`, bookkeeping
`runtime.ts:bookkeepingMode/ownRuntime`, `query.ts:resolveQueryConfigDir`,
`tokenRefresh.ts:configDirToCredentialsFile`, and `telemetry/index.ts`.
Session mappings, turn locks, GC sidecar/lock, deletion gates, recovery state
and any native bookkeeping DB/guards all derive from the private session root.
JSON bookkeeping (the existing default) was explicit. Empty private mappings
contain no production transcript locators. Native transcripts resolve under the
private Claude config; even a shared-memory fallback would use private HOME.
Remaining HOME-based caches, native credentials, attestation keys and optional
backend stores resolve into private HOME/config or remain disabled. Scratch
ports were allocated by loopback `bind(0)`, not production port 3456.

Detailed preflight and state-path search are retained in the evidence directory.
No scratch server started until this boundary had been established.
Only scratch main PIDs or native executable matches **within descendants of
that scratch main PID** were signalled. There was never a process-name kill.

## Actual Linux E2E

Escrow: `scripts/e2e-signal-exit.mjs`. It imports Pi's real Anthropic provider,
normalizes its real context, consumes its AssistantMessageEventStream and uses
its real `isRetryableAssistantError`. It **does not start a headless Pi session**.
This qualifies Pi's implicated provider/error policy, not its interactive TUI,
outer automatic retry loop or extension discovery.

Tuple: Linux x86_64, Node 22.23.4, Pi AI 1.5.2 from `/srv/pi/current`,
Agent SDK 0.2.141, native Claude Code 2.1.322, requested/native-pinned
`claude-haiku-5-5`. Initial drain telemetry records that resolved model;
this is forwarding evidence, not an independent upstream served-model receipt.
Five live model calls total (including one harness-error drain run); drain
refusal requests never reach the model.

| Case | Signal after first text | Client outcome | Timing from request | Server exit |
|---|---|---|---|---|
| Baseline, detached 8ea701d1 build | only descendant 142268 of server 141562 | SSE `api_error`, code 143 login advice; Pi retryable **false** | first text 4845 ms; error 4903 ms | 0 |
| Fix build | only descendant 144357 of server 144155 | SSE transient `api_error`, exit code 143; Pi retryable **true** | first text 4850 ms; error 4918 ms | 0 |
| Fix, normal 30 s drain | only server 371850 | admitted turn receives `message_stop`; Pi stopReason `stop`; drain requests 503/retryable **true** | SIGTERM 2000 ms; message completion 10437 ms (8437 ms after TERM); total server lifetime 10970 ms including 464 ms startup | 0 |
| Fix, forced 250 ms grace | only server 376793 | socket closes, **no SSE error event**, no `message_stop`; Pi retryable **true** | SIGTERM 5215 ms; transport error 5471 ms (~256 ms later) | 0 |

Both crash cases were HTTP 200 streams: the later error cannot change their
HTTP status, so the message is essential. Every successful case joined the
original server close and both captured pipes and observed zero surviving
captured descendants before disposing of private state.

The initial drain harness sent a second SIGTERM in `finally` while the first
shutdown was still settling, triggering the deliberate second-signal exit 130.
This is not counted as a successful drain. Its telemetry independently shows a
200 completed Haiku request (10763 ms) and normal mapping publication. The
harness now tracks whether it already signalled the main PID; the rerun above
passed. The failed control remains recorded separately. No production process
was involved.

### Reproduction

Build the baseline and candidate separately, then use fresh scratch case
subdirectories (the harness refuses to reuse them):

```sh
E2E_ALLOW_LIVE_MODEL=1 \
E2E_BASELINE_ROOT=/absolute/built/8ea701d1 \
E2E_MERIDIAN_ROOT=/absolute/built/candidate \
E2E_PI_AI_ROOT=/srv/pi/current/node_modules/@earendil-works/pi-ai \
E2E_CLAUDE_BIN=/absolute/native/claude \
E2E_CREDENTIALS_FILE=/private/read-only/source/.credentials.json \
E2E_SCRATCH_ROOT=/mnt/ai-scratch/meridian-signal-exit \
node scripts/e2e-signal-exit.mjs
```

`E2E_CASES` can select comma-separated case labels from the table's four harness
labels (`baseline-crash`, `fixed-crash`, `fixed-drain`, `fixed-grace`). Review
isolation against the intended installation before using any credential source.
The forced-grace case intentionally shortens the deadline to bound model cost;
the normal drain case uses the production default 30000 ms unchanged.

## Exact client retry check (scratch-only)

`evidence/client-check.mjs` imports the operator-named retry utility and passes
`{stopReason:'error', errorMessage:<actual Pi provider output>}`. Exit 0:

```text
baseline-crash: false (expected false)
fixed-crash: true (expected true)
drain-503: true (expected true)
grace-expiry-socket: true (expected true)
```

The first two messages are JSON strings containing the whole SSE error event,
not only `error.message`. New signal wording:

```text
Service temporarily unavailable: the Claude Code process serving this request was stopped by a signal (exit code 143), as happens when Meridian restarts. Retry the request.
```

The existing response pipeline additionally includes `retry_after:5` in the new
503 SSE error. Actual drain errorMessage:

```text
503 {"type":"error","error":{"type":"overloaded_error","message":"Meridian is shutting down and is not accepting new requests. Retry against another instance."}}
```

Actual forced-grace errorMessage:

```text
terminated: other side closed (UND_ERR_SOCKET)
```

Therefore neither the drain message nor the forced-grace path needs a code
change. Exact old/new JSON error strings and all predicate output are retained
in `client-check.log`.

## Final gates and known baseline failures

- `npm run typecheck`: exit **0**, `tsc --noEmit`.
- `npm run build`: exit **0**, Node-compatible bundles certified.
- `TMPDIR=<scratch>/tmp npm test`: pretest typecheck passed; exit **1**,
  **7386 pass / 28 skip / 873 fail**, 8287 tests, 488 files, 524.23 s.
  Scratch is filesystem type `1702057286`; bookkeeping rejects it as
  unsupported. Unchanged 8ea701d1 with the identical command also exits **1**:
  **7222 pass / 28 skip / 1026 fail**, 8276 tests, 516.51 s. This causes broad
  initialization cascades and is not a signal-classification regression.
- Additional diagnostic full run with the existing filesystem opt-in
  `BOOKKEEPING_ALLOW_UNVERIFIED_FS=1`: exit **1**, **8241 pass / 28 skip /
  18 fail**, 2 errors, 8287 tests, 785.52 s. This opt-in was test-only, never
  production configuration. It cannot reach child fixtures that intentionally
  replace their entire environment. Seven mapping-read tests change from seven
  failures on baseline without it to seven passes with it, demonstrating the
  filesystem guard independently.
- All **18** remaining failed test names reproduced on unchanged 8ea701d1 in
  the six corresponding files (17 failures together, the remaining GC timing
  failure in an additional isolated baseline run). Native child fixtures
  still reject the filesystem; `json-slow` has the same false final-owner
  release assertion on baseline, and GC-budget tests reproduce timeout/lost
  deletion-lease assertions. The two `owned setup failure` diagnostics also
  occur in the baseline full suite. These pre-existing bookkeeping/fixture
  failures were **not repaired or hidden**. Since the first npm-test group
  fails, its subsequent `&&`-chained isolated groups are not claimed as run.

The npm-test gate is **not green**; broader bookkeeping qualification on this
scratch filesystem remains a pre-existing residual risk. No unrelated storage
or lifecycle patch was folded into the signal classification fix.

## Evidence retention

Full logs, client script/output, isolation preflight, server logs, generated SSE
and reports are retained at:

`/mnt/ai-scratch/meridian-signal-exit/evidence/`

Key files: `targeted-red.log`, `targeted-green.log`, `live.log`,
`drain-live.log`, `client-check.log`, `isolation.md`, `npm-test.log`,
`baseline-npm-test.log`, `npm-test-fs-opt-in.log`,
`baseline-gate-failures.log`, `baseline-gc-budgets.log`, `typecheck.log`,
`build.log`. Earlier task-pass logs are preserved as
`previous-pass-placement-blocker.log` and `previous-pass-existing-test-conflict.log`.
Private credentials, run state and the baseline worktree are
removed after joined verification; only cited evidence remains. This committed
record and harness preserve the result beyond transient scratch availability.
