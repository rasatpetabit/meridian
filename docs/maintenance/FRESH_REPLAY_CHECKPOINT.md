# Fresh replay checkpoint — offline evidence (2026-11-13)

Scope: `fix/fresh-replay-checkpoint`, base `abd56e2560ea91fbf5929b430261a122641d4ed6`
(Meridian 1.89.0). No live Meridian requests, service operations, installation,
push, or release. SDK 0.2.141; native CLI checks on Linux x64 with both
2.1.322 (the implicated runtime executable) and dependency CLI 2.1.296.

## Root cause and hypothesis results

Base `src/proxy/server.ts:8299-8307` requires `canRecoverAsToolUse` to publish
the settled checkpoint after a max-turns error. That requires hook capture
(`errors.ts:770-779`). Base `server.ts:8309-8315` consequently evicts uncaptured
calls even when the CLI explicitly refused dispatch and delivered a canonical
result. The assumption at base `server.ts:8287-8292` conflates two cases:
uncaptured abort-window calls without a committed transcript, and canonical
name-dispatch refusals whose transcript **is** committed.

- **H1, early-stop/capture race: not reproduced; refuted for this mechanism.**
  The hook captures synchronously before its deny hold (`server.ts:4762`), and
  the tracker freezes only after iterator settlement. Fresh-replay controls
  exercise a hook during generation, after the stream boundary, and after
  assistant metadata: all capture one call, publish, and resume the exact
  assistant UUID on the next request, on base as well as candidate. A CLI
  refusal is itself a `tool_result`, so `passthroughEarlyStop.ts:164-170`
  settles it without any hook having run. Thus `checkpoint_ready captured=0`
  need not mean the array was prematurely spliced.
- **H2, CLI rejection before PreToolUse: confirmed offline with the real CLI.**
  A loopback fake Anthropic response emits bare `read` while the actual
  advertised tool is `mcp__oc__read`. With eager tools and tool search off, the
  CLI returns `<tool_use_error>Error: No such tool available: read</tool_use_error>`
  without invoking PreToolUse, emits `error_max_turns`, and writes the exact
  assistant UUID and rejection to its transcript. The existing proxy then
  reproduces the captured-zero/no-publication failure. This is a name-dispatch
  failure, not missing deferred-tool discovery. The candidate publishes it;
  the next real SDK/CLI query resumes at that UUID, rewinds the rejection, and
  sends the native tool call plus the real client result upstream.
- **H3, undefined fresh-target identity: refuted for this mechanism.**
  `server.ts:6235-6237` starts with the preallocated target ID. A fresh-replay
  control omitting *every* returned SDK session ID still publishes and resumes
  the preallocated target. The real CLI harness also validates the mapped
  transcript and assistant UUID before returning the client terminal pair.

Journal inputs were read at the operator's named time windows. Request
`71b8d04a` has fresh preparation → checkpoint-ready captured=0 → max-turns
failure → drain-error eviction, without a deny-hold release. Request
`8ab56981` releases a held deny, freezes captured=1, then publishes after the
same max-turns failure. The matched client's 19:54:54.130Z turn received a
`bash` call with the exact journal usage totals (370435 cache-write tokens).
The running process's uncaptured-recovery override was unset. Default recovery
requires explicit id/name-matched CLI rejection (`errors.ts:960-975`), which
supports H2, not an unobserved host-hook race. The GC'd SDK transcript prevents
recovering that original call's raw SDK name/refusal text; no claim is made
that every production captured-zero occurrence has the same rejection subtype.

## Fix and safety boundary

Candidate `server.ts:8302-8320` admits the canonical name-dispatch-refused
checkpoint alongside captured recovery. It additionally requires:

- a keyed request and the one-turn budget;
- an iterator-observed canonical result;
- complete streamed calls all declared by the client;
- exact CLI name-dispatch rejections for every call and no dropped calls;
- the existing settled UUID, complete ID set, non-independent request, and
  generation/publication/CAS guards.

Malformed-input rejection, undeclared tools, headerless requests, missing
canonical results, larger budgets and other drain errors retain eviction.
Early stop, the cap, and retry behavior are unchanged. Ordinary continuation
tool caching is reused unchanged; the evicted-turn one-shot tool grant keeps
its previous semantics. No new public interface, configuration, dependency,
product or architecture choice is introduced.

## Reproduction and verification

### HTTP regression (mocked SDK)

```
bun test src/__tests__/passthrough-early-stop-integration.test.ts --timeout 30000 --test-name-pattern 'fresh replay checkpoint'
```

With base `server.ts` restored temporarily and then restored to candidate in
`finally`: **5 pass, 1 fail**, at the persisted-session assertion in
`stream: fresh replay checkpoint (cli-rejected)`:

```
Expected: "<preallocated session UUID>"
Received: undefined
```

The test first asserts `checkpoint_ready.captured === 0` and no deny-hold
release. Candidate: all six matrix cases pass, including the negative case
without a canonical result. The complete early-stop file: **181 pass, 0 fail,
1618 assertions**. Lineage, denial, and uncaptured-recovery focused files:
**39 pass, 0 fail**. Tool-cache compatibility files: **10 pass, 0 fail**.
Existing rejection tests now assert exact published IDs and resumed UUIDs,
rather than merely deleting their former eviction assertions. The empty-tools
test covers both canonical continuation caching and the old uncommitted grant.

### Real SDK/CLI, fake upstream

```
bun scripts/e2e-offline-fresh-checkpoint.mjs --claude=/absolute/path/to/claude
```

Base `server.ts`, CLI 2.1.322: exit 1,
`AssertionError: fresh canonical rejection lost its mapping`.
Candidate, both CLI 2.1.322 and 2.1.296: exit 0:

```
PASS fresh: CLI rejected bare read before PreToolUse; canonical transcript and checkpoint exist
PASS continuation: native assistant and real client result; rejection rewound; exactly two upstream calls
```

The harness creates disposable HOME/config/session directories, uses only a
loopback fake upstream and dummy key, and removes scratch in `finally`.
It asserts real on-disk checkpoint existence before terminal delivery, native
assistant/result context after resume, and exactly two upstream requests.
This proves persistence and transport, **not** live model selection, real cache
billing, or production activation. No live model calls were made.

### Full package script and gates

- Base `bun run test`: **8236 pass, 28 skip, 1 fail**, 8265 tests in the main
  489-file batch. Failure: `store-mutation-baseline.test.ts:116`,
  `matches actual legacy mutation durability/order, rather than the one-sync comparison`.
- Final `bun run test`: **8237 pass, 28 skip, 1 fail**, 8266 tests in that batch.
  The same pre-existing failure is the only failure. The script's `&&` stops
  there, so all **29 remaining package-script commands were also executed
  individually in order**: **758 pass, 0 fail**. Combined executed package
  coverage: **8995 pass, 28 skip, 1 pre-existing failure**.
- The failing store test passes alone (**3 pass, 0 fail** in its file), indicating
  a full-process interaction; it was not modified or hidden by this patch.
- `bun run typecheck`: exit 0. `bun run build`: exit 0. `git diff --check`: clean.

An intermediate broad change to tool inheritance produced four cache-test
regressions. It was removed, not accepted; the final full batch has none of
those failures. No test exclusions or package-script changes were made.

## Handoff and remaining limits

Implementation and verification are local to the named worktree; other
worktrees and the user's untracked `.pi/` directory were preserved. The runtime
fix is bounded to demonstrated canonical declared-name refusals; other
captured-zero causes still fail closed. Live-model/real-cache evidence is
absent by task constraint. Cross-vendor review was unavailable through this
agent's supplied tools; this is a locally verified change, not deployment or
merge approval. Parent/operator review remains a landing gate, as does the
pre-existing full-suite failure. No new architecture/product escalation.
