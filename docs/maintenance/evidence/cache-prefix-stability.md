# Retained cache-prefix stability: offline causal regression

## Scope and result

Base: Meridian `a627a528d656b0a3bee62348af4ec87dfd8071ac` (1.79.0),
Agent SDK 0.2.141, Claude Code 2.1.284, Linux. No live model calls.

`runSdkQueryAttempt` previously joined the SDK child and then invoked
`prunePriorThinkingFile` on the new transcript. That fork contains inherited
history, not just new output. `prune` removes thinking from completed assistant
message groups. In a tool loop, a previously pending group's thinking survives
one request, is sent as provider input with its tool result, and is then removed
when that result makes the group completed. The next resume therefore inherits
an altered, already-sent prefix. This is an explicit Meridian rewrite, not proof
of a CLI fork mutator.

The repair removes post-query pruning from the shared attempt runner, including
streaming, non-streaming, fallback/replay and silent-recovery callers. Joining,
lifecycle fencing, checkpoint rewinds and fresh replay are unchanged. Legacy
pruning flags are ignored. Fresh replay still excludes client-echoed thinking.
The old standalone pruning utility is not called by the runtime; its isolated
transformation tests remain historical characterization, not evidence of current
request behavior.

## Reproducer

The existing SDK/CLI SSE fixture pattern in `scripts/e2e-capped-turns.mjs` is
extended by `scripts/e2e-cache-prefix.mjs` for this scenario. It runs the real
HTTP request preparation, lineage/delta selection, lifecycle fork, SDK and CLI
against a local mock provider. Only the SDK `query` entry is observed, without
changing its arguments or emitted events. No transport interception for cache
markers is introduced.

The harness creates one synthetic pending tool-call transcript with pruning off.
For ON and OFF arms, it restores the same synthetic session mapping and asserts
that the source transcript remains byte-identical, including its checkpoint.
Both tool-result requests must resume that same session and produce identical
provider-visible starting messages. It then compares the next provider request.

```sh
# Existing private scratch directory on disk; no credentials needed.
TMPDIR="$SCRATCH" bun scripts/e2e-cache-prefix.mjs --scratch="$SCRATCH" --stream
# Omit --stream to exercise non-streaming.
# To test unmodified source using the exact same harness:
#   --source-root=/path/to/unmodified/meridian
```

Optional actual Hindsight injection/fold characterization:

```sh
NODE_PATH="$HINDSIGHT_DEPENDENCIES" TMPDIR="$SCRATCH" \
  bun scripts/e2e-cache-prefix.mjs --scratch="$SCRATCH" --stream \
  --hindsight-root="$HINDSIGHT_SOURCE" --fold-file="$LINEAGE_FOLD_SOURCE"
```

This executes the actual `createRecallTurnPolicy().recall` used by Hindsight's
context callback, with an in-process synthetic recall client (no service calls),
and actual `foldTransients`. Pi's `toolResult` hook role is represented before
conversion to Anthropic `user/tool_result`; append recall therefore skips tool
continuations just as production does. Full Pi orchestration and Hindsight
network transport are not exercised. Inputs used: pi-hindsight `e1aa3f7` and
`/srv/workflows/pi/extensions/meridian-lineage-fold.ts` as inspected locally.

## Red then green

| Actual provider-bound behavior | Base, flag ON | Base, flag OFF | Repair, either flag |
|---|---|---|---|
| Earlier thinking unchanged | no | yes | yes |
| Earlier message checkpoint content prefix unchanged | no | yes | yes |
| Checkpoint within new marker's 20-block lookback | content invalidated | yes, 2 blocks behind | yes, 2 blocks behind |
| Original recall visible, exactly once | yes | yes | yes |
| Fresh recall visible, exactly once at new tail | yes | yes | yes |
| Harness exit | 1 | arm passes | 0 |

Streaming base first difference: `messages[1].content[0]` (thinking), before the
previous checkpoint `messages[2].content[0]` (tool result). Non-streaming includes
an additional SDK environment message: the corresponding indices are 2 and 3.
Tools and the actual generated system array are compared and are stable in this
fixture. Thinking, signatures, reminders, roles and whitespace are not
normalized. Only `cache_control` annotations are excluded from content identity;
their positions are compared separately. The marker's location can move without
altering the content of a historical checkpoint.

On the repaired streaming path the shared message prefix is observed unchanged
in this fixture, but the asserted guarantee is only the already-sent thinking
and the prefix through the previous message checkpoint, not entire-history
equality. The non-streaming fixture still changes an SDK tail nudge *after* the
previous message checkpoint; this patch does not claim to fix it. A structurally matching
checkpoint is not a measured cache hit: the mock neither implements Anthropic
caching nor validates signed thinking, and the synthetic fixture is small.

Focused mocked-HTTP regressions were changed before source repair: three failed
in `proxy-prior-thinking.test.ts`, six in `proxy-prior-thinking-loop.test.ts`.
After repair, both files pass (13 tests total), covering streamed thinking,
legacy flags, immutable source/fork contents, completed tool steps and
non-stream/stream fresh replay plus model fallback. Obsolete post-prune fault
injection cases were removed, since there is no post-query pruner to refuse.

## Cost and evidence limits

The synthetic thought is 69 UTF-8 text bytes, plus its signature/JSON framing.
A named private source fixture's affected block measures 4,077 serialized UTF-8
bytes: 665 thinking text bytes and 3,360 signature bytes. These are measured
input-size increments, **not token counts or dollar estimates**. Retaining more
history can increase context use and bring compaction forward; net live costs
must be measured after separate activation authority. Earlier claims of pruning
savings did not control for the invalidated cache prefix.

No immutable recall snapshot or new persistence/lifecycle contract was needed:
provider-visible historical recall survives resumed delta selection here. No
Pi, Hindsight, fold-extension or installed-package changes were made.

Frozen historical snapshot comparisons remain red even after the source repair;
they already contain the deleted blocks and cannot be healed by removing a
future rewrite. They establish propagation of their input differences, not
causal attribution or a source-fix green gate. The new causal harness supplies
that red-to-green gate.

This does **not** explain all misses, prove production dynamic-system stability,
identify the exact 48,540-token breakpoint, or establish actual cache savings.
Independent cross-vendor review and separately authorized affected-flow live
verification are still required before acceptance/activation. No publication,
installation, service restart or deployment was performed.

## Local verification and handoff gate

- Causal SDK/CLI harness: exit 1 against the base, exit 0 against repair in both
  stream modes. Original/fresh recall and checkpoint assertions pass.
- Focused HTTP regressions: 13 pass, 0 fail. Typecheck and build: exit 0.
- `npm test`: exit 1; its first stage reports 4,746 pass, 1 skip, 1 fail.
  `antigravity-attachments.test.ts` / “parses a multi-megabyte attachment in
  production Node without regex stack overflow” fails because `/usr/bin/node`
  v22.22.1 reports `ERR_NO_TYPESCRIPT: Node.js is not compiled with TypeScript
  support`. The same test fails unchanged on the untouched base (2 pass, 1 fail).
- All 17 later commands declared in the `npm test` chain were run separately
  after its short-circuit: 445 pass, 0 fail, every command exit 0.
- No commit: the task explicitly prohibits committing with unresolved test
  errors. The Node-runtime prerequisite remains open; no unrelated test was
  weakened and no runtime was installed. Independent review can inspect the
  uncommitted isolated worktree before that gate is resolved.
