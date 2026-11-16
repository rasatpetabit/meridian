# Prompt-cache keepalive: real CLI, offline upstream

## Result and boundary

2026-11-16, Linux x86_64, Node v22.23.4, Bun 1.3.14, Agent SDK 0.2.141,
Claude CLI **2.1.322** (`/home/ras/.local/share/claude/versions/2.1.322`).
Native executable SHA256:
`bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478`.

All nine keepalive scenarios pass against the real native CLI, with **zero live
model calls**. The full committed matrix passes **66/66**. No production source,
settings, service, credentials or session store was changed. No push, merge,
installation or activation was performed.

**This is wire-compatibility evidence, not a measurement of actual cache warmth.**
The upstream is scripted: its cache usage is deliberately synthetic. This cannot
establish a provider TTL, cache hit, exact provider token count, cost benefit or
actual Pi-client acceptance. Production enablement remains the parent's decision.

Two precise qualifications apply to the requested byte comparisons:

- System and tools are compared byte-for-byte by JSON serialization, including
  cache annotations. Message **content** uses the existing matrix's R1 convention:
  remove request-local `cache_control` annotations and equate a content string
  with its singleton text-block representation. No content text is changed.
  Raw message JSON is **not** byte-identical: the native CLI moves breakpoints as
  history grows. This is not a newly weakened production contract.
- Each follow-on's entire request is compared byte-for-byte with its independent
  no-beat control, **excluding only `metadata`** (observed sole key: `user_id`,
  containing SDK-generated account/session identity). Cache markers are **not**
  removed for this comparison. Literal whole-body equality including independent
  session IDs is not claimed.

If the parent requires literal raw message/metadata equality or exact provider
token counts, these gates do **not** satisfy that stricter interpretation. Do not
silently promote this record to production approval.

## Source and isolation

Worktree: `/srv/dev/ai/meridian-wt-keepalive`.
Branch: `test/keepalive-wire`, based on main at
`51cea9b4dfd9e9257aa3f694f44ccdf197bb7b37`. Main had already advanced beyond the
brief's `74a5c99d`; the initial matrix contained 57 rather than 55 rows.
During the run main advanced again to `cb93e802` (journal-gate script/tests only).
This branch was not rebased or integrated. Retest the combined tree before landing.

The existing checkpoint harness dispatches `--keepalive=<shape>` to
`scripts/e2e-offline-keepalive.mjs`. That helper uses the actual HTTP handler,
keepalive registration, scheduler, runner, gated/joined SDK query and native CLI.
Only the scheduler's existing `now` dependency and the synthetic profile's
resolved **type** are injected. The API profile's dummy key/loopback URL remain
unchanged; calling it `claude-max` permits the real subscription-only registration
and account checks without borrowing an actual subscription. No SDK or runner
implementation is mocked. The server's existing `tickCacheKeepalive` fires a beat
at 55 minutes + 1 second on the injected clock, without waiting 55 real minutes.

Each scenario runs a no-beat arm and a beat arm, using the same isolated cwd but
independent session keys. Real turns go through HTTP with Pi-shaped headers; this
is not the Pi binary. All HOME/config/session/work directories are fresh under
`MERIDIAN_E2E_SCRATCH`. Provider credentials and inherited operational overrides
are removed in that disposable child. No product test seam was added.

The beat receives only `message_start`; the fixture holds output for 8 seconds.
Within 6 seconds it must see the connection cancelled and scheduler in-flight
count return to zero. This exercises the production gated query's close/join.
Before/after JSONL file sets and bytes, plus the complete published mapping, must
remain unchanged. The next real request must retain continuation lineage, deliver
each real tool result exactly once, exclude the beat prompt/output sentinel, and
match the independent control. Hybrid rows explicitly witness the first native
result and later non-native completed-call records. The thinking row retains the
thinking block/signature. At the tool-checkpoint beat, results have not been sent.

## Reproduce and per-row results

Run from the worktree with this common command prefix (scratch must be tmpfs or a
local filesystem, not virtiofs):

```sh
MERIDIAN_E2E_SCRATCH=/tmp/meridian-keepalive-scratch TMPDIR=/tmp \
  bun scripts/e2e-offline-fresh-checkpoint.mjs \
  --claude=/home/ras/.local/share/claude/versions/2.1.322
```

Append the row's arguments below and optionally `--wire=/owned/path/<row>.json`.
Each row includes its own no-beat control. The exit codes below were also checked
by the full matrix. Sizes measure the shared last-real-request system/tools/message
prefix, not the appended beat prompt or the beat-only transcript suffix.
**Tokens are estimates**, obtained from the repository's existing
`replayBudget.estimateTokens` on the serialized prefix; they are not the fake
usage's 20,000 tokens and not provider tokenization. Serialized bytes are exact.

| Row | Arguments | Exit | Prefix bytes | Estimated tokens |
|---|---|---:|---:|---:|
| Text end_turn | `--keepalive=text` | 0 | 7,941 | 2,268 |
| Captured single → end_turn | `--keepalive=single` | 0 | 8,061 | 2,302 |
| Captured 2-call hybrid → end_turn | `--keepalive=parallel2` | 0 | 8,385 | 2,395 |
| Captured 3-call hybrid → end_turn | `--keepalive=parallel3 --keepalive-prove-red` | 0 | 8,709 | 2,487 |
| Pending 2-call checkpoint | `--keepalive=checkpoint` | 0 | 7,821 | 2,234 |
| Mixed 3-call, second bare → end_turn | `--keepalive=mixed --mixed --bare-call=2` | 0 | 8,709 | 2,487 |
| Thinking on | `--keepalive=thinking` | 0 | 8,142 | 2,325 |
| Five-minute tier | `--keepalive=5m --keepalive-prove-red` | 0 | skipped | no beat |
| Nine pending calls | `--keepalive=wide --keepalive-prove-red` | 0 | skipped | no beat |

Decisive lines for each eligible row (sizes vary as above):

```text
PASS beat abort: upstream cancelled after message_start; no output sent
PASS beat prefix: byte-identical system/tools; R1 message content unchanged {"bytes":8709,"estimatedTokens":2487,"method":"Meridian replayBudget estimate (not provider tokenization)"}
PASS follow-on: no-beat control byte-identical (session metadata excluded); continuation; real results exactly once; no beat prompt/output; same warmed prefix
```

Skip witnesses:

```text
PASS keepalive skip: ephemeral_5m_input_tokens; zero upstream requests
PASS keepalive skip: 9 pending calls (>8); zero upstream requests
```

The matrix's permanent output, including every new row's individual decisive
lines, token estimates, native versions and `liveModelCalls:0`, is retained in
[keepalive-wire-matrix.txt](keepalive-wire-matrix.txt).

## RED demonstrations and failures retained

1. **Actual native CLI RED**: append `--keepalive=parallel3
   --keepalive-red=tools` to the common command. The scheduler fixture adds an
   extra private MCP tool to the beat recipe only. Exit **1**:
   `AssertionError: beat tools must be byte-identical`.
   Without that flag the same CLI scenario passes. The injection is opt-in,
   harness-only; production source is never edited. The final full matrix ran
   without the flag and passed.
2. `--keepalive-prove-red` copies real captured witnesses and runs the **same**
   assertions against deliberate corruptions, requiring `ERR_ASSERTION`, then
   discards each copy. This covers system bytes, tools bytes, message prefix,
   prompt isolation, output isolation, control equality, continuation lineage,
   exactly-once results, first-response abort, mapping/transcript immutability
   and ineligible skip. Each must print `PASS RED demonstration: ... rejects
   perturbed recorded-wire witness (restored)`. These are checker mutation tests,
   not claims that production exhibited those defects. They do not change wire
   requests or evidence in the positive arm.
3. Initial strict raw-message comparison exited **1** on the text row:
   `AssertionError: beat messages must begin with last real request unchanged`.
   The last real user block had `cache_control:{type:"ephemeral"}`; that block
   in the longer beat request did not. The text was identical. The final content
   comparison explicitly uses the already-established matrix R1 convention;
   it does not claim the initial raw assertion became green.
4. A system-option perturbation on the resumed native CLI did **not** change its
   recorded system (exit 0). It was ineffective as a negative control and was
   removed, not counted as RED. System-byte checker coverage comes from (2).
5. The first isolated HTTP unit run used Bun's default 5-second timeout and
   reported 12 pass / 3 fail / 1 error: the 300-tick test alone sleeps at least
   7.5 seconds, and its late work cascaded into following tests. With the repo's
   prescribed `--timeout 30000`, unchanged tests passed 15/15 in 13 seconds.
   Both complete `npm test` runs also passed. No unexplained green rerun or
   product repair is claimed.

No keepalive implementation defect was demonstrated. No production fix or spec
behavior change was made.

## Final local gates

```sh
MERIDIAN_E2E_SCRATCH=/tmp/meridian-keepalive-scratch TMPDIR=/tmp \
  bun scripts/e2e-wire-matrix.mjs --claude=/home/ras/.local/share/claude/versions/2.1.322
TMPDIR=/tmp npm test
npm run typecheck
npm run build
TMPDIR=/tmp bun test --timeout 30000 src/__tests__/proxy-cache-keepalive.test.ts
```

- Matrix: exit **0**, **66 pass / 0 skip / 0 fail** (seven beats and two
  deliberately ineligible no-send rows among the nine additions).
- `npm test`: exit **0**, **9,136 pass / 28 skip / 0 fail** across its 32 isolated
  invocations; the final name-filtered invocation also reports 274 filtered-out
  tests. The 28 skips are 27 optional `BOOKKEEPING_COMPAT_TARBALL` cases and one
  Windows-only case. The pretest typecheck ran normally.
- Explicit typecheck and build: both exit **0**. Final build:
  `Certified local build 2 (fe95e2a0-8a6c-43fa-9503-45fabc924f64)`.
- Keepalive HTTP regression suite at 30-second timeout: **15 pass / 0 fail**,
  72 expectations, exit **0**.
- Final diff/whitespace check: `git diff --check`, exit **0**.

## Read-only live eligibility facts

Observed during this task, without changing production:

- `~/.config/meridian/profiles.json`: `personal`, `work`, `julian` all **omit**
  `type`. `resolveProfile` defaults an omitted type to **claude-max**. Thus Pi's
  `profile=work` is a subscription-type profile, not an API profile. Only IDs
  and type fields were read out; no credentials were printed.
- Serving Node PID 1726091's environment had neither `MERIDIAN_MAX_CONCURRENT`
  nor the legacy `CLAUDE_PROXY_MAX_CONCURRENT`. The source default is **10**,
  independently confirmed by real diagnostic lines `sdkActive=1/10` and `0/10`.
- `GET /telemetry/summary` reported, in one 3,600,000 ms window, 232 real
  requests, 68,201,219 cache-read tokens, 2,348,226 cache-creation tokens,
  average hit rate 0.96 and **zero keepalive beats**. `/telemetry/requests`
  likewise exposes aggregate creation/read counts. Neither endpoint, `/metrics`,
  nor the inspected recent service diagnostics expose `ephemeral_1h_input_tokens`
  versus `ephemeral_5m_input_tokens`. Therefore **recent real one-hour-tier writes
  are unknown**, not proved by these aggregate numbers or the profile type.
  Production transcripts/session storage were not inspected to fill that gap.

## Handoff / residual gates

No public interface or architecture decision was introduced. Clock/account
injection and test-only fault injection are fixture implementation choices.
The parent owns whether the explicitly bounded R1/metadata comparison and token
estimates are sufficient for activation, and the missing current one-hour-tier
usage witness. This record authorizes no production action. It does not qualify
other native versions, platforms, actual Pi behavior, long-idle provider warmth,
cache economics or concurrent beat/real-turn races beyond existing HTTP tests.

A separate worktree had concurrent edits to the same checkpoint/matrix paths.
Its files were not changed. Its owner must reconcile row lists/counts when
integrating. No independent review tool/lane was available to this bounded
engineer; this is executed evidence plus self-review, not independent production
approval.
