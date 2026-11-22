# Native parallel tool results on the Meridian fork — 2026-11-22

Fork base `4daa97ce1758d0328fa26127d0138986d7a82cfa`; implementation
`931a1bd645fa9b9a8c0c341614458136c8eb096c`. Port of `00475bf6` and `1ecdbe95`.
Linux x86-64, Bun 1.3.14, Node 22.23.4, Agent SDK 0.2.141, and the fork's
production-pinned Claude Code 2.1.322. No production traffic, activation,
restart, or changes to fork main in this verification.

## What the port preserves

| Existing fork guarantee | Port and witness |
| --- | --- |
| Keyed mixed and wholly bare-name rejection batches retain a first-fragment hybrid checkpoint, including distinct IDs. Unkeyed rejection-only batches do not qualify. | Freeze first distinguishes genuine hook capture from the existing name-dispatch proof. Only all-captured batches can elect native continuation; name-dispatch batches retain the same hybrid proof, keyed capped-recovery gate, canonical publication conditions, and null undo slot. The existing bare-first/later, all-bare and unkeyed tests remain. `bare-2-distinct` verifies that two bare calls still use hybrid without ID overlap. |
| Unkeyed packed first turns are independent, with no mapping lookup, publication, or recovery invalidation. The first tool-loop request derives its own key; later turns resume. | The stream proof affects checkpoint eligibility only; it does not change packed-chat classification, the `isIndependentSession` gates, mapping CAS checks, or JSON publication. The existing concurrent HTTP and native-wire tests and live chat driver passed. |
| Keepalive warms the right prefix without changing the stored mapping, source transcript, or next real request. | No runtime keepalive changes. Existing hybrid witnesses now use intentionally overlapping IDs (the mixed bare-name fixture still uses disjoint IDs). Three new rows verify the same keepalive invariants for native two- and three-call continuations and a pending native checkpoint; the no-beat controls and skip cases remain. |
| Capped or deferred JSON tool batches reach the client with the existing input/attempt proof; unqualified multi-call checkpoints replay. | The new capability is opt-in from primary SSE freeze, passed to normal SSE publication and canonical capped-error recovery. JSON and silent-turn recovery retain the default rejection of multi-call publication. All five fork JSON refusal rows, captured JSON rows and unstreamed controls passed. |
| Existing hybrid mappings use their stored first UUID. | The stored hybrid marker remains authoritative regardless of ID shape. Newly qualified native batches reuse the last UUID and full ID set, without a storage-format change. Old overlapping mappings without a hybrid marker replay (two- and three-call mocked regressions). |

## Wire and live evidence

- `bun scripts/e2e-wire-matrix.mjs --claude=<pinned CLI>` exited 0, **85/85**,
  zero live model calls. All 73 fork rows remain. The additions cover the eight
  correction rows, distinct bare, and three native keepalive rows. The retained
  synthetic bodies independently verify **148 byte-equivalent normalized R1
  edges across 62 rows**, including 55 keepalive and three unkeyed chat edges.
  The comparison excludes moving cache annotations and equivalent string versus
  singleton-text-block content, not message order, tool definitions, or text.
  Rows that replay do not claim prefix preservation.
- The distinct three-call fixture on unchanged fork main failed the port's
  checkpoint assertion; the recorded continuation had native real-result
  counts `[1,0,0]`. On the port, `distinct-3-follow` had `[1,1,1]`, no
  placeholders, and unchanged prefixes through the native, hybrid and single
  follow-on rounds. `alias-base-last` still hybridizes the overlapping batch,
  then resumes a suffixed but non-overlapping batch natively. Native later-call
  images remain native; unproved hybrid image and incomplete shapes replay.
- `PROBE_PARALLEL=1 PROBE_ADAPTER=pi bun scripts/e2e-passthrough-turns.mjs --stream`
  exited 0 with an isolated Claude Max config, an isolated loopback port and
  `PROBE_MODEL=claude-opus-5-5`. One batch of three calls, exactly one native
  receipt for each in the active SDK fork, two unchanged parents, and an `OK`
  saved-session follow-up. The two continuation cache reads were 3165/3165 and
  3841/3841 prior cache tokens. This was the Pi-shaped HTTP adapter, not a Pi
  process.
- `node scripts/e2e-unkeyed-chat.mjs --claude=<pinned CLI> --credentials=<private login>`
  exited 0 on an isolated built proxy. `MERIDIAN_DEFAULT_FABLE_MODEL=claude-opus-5-5`
  was set before the Fable reset. Three independent first turns, three new
  tool-loop lineages, and three third-round continuations passed the cache gate;
  cache writes were 90, 90 and 72 tokens. This does not verify live Fable 5.2.

Private artifacts on the verification host: `/mnt/ai-scratch/meridian-native-results-evidence/`.
`wire-matrix-haXSLx/` contains all 85 synthetic request recordings;
`baseline-distinct-3-wire.json` contains the baseline comparison.
`compare-wire.py` derives `prefix-proof.jsonl`, with byte lengths and SHA-256 per
edge (`1f23703c42646a43ef58c24c46f225bf071f233aae4e450a0c4f59314e1a581c`
for the manifest). The directory also contains the matrix, live and local test
logs. No credentials or live request bodies are part of the branch.

## Local gates

- Focused early-stop, parallel/hybrid, and deny-hold files: **429 pass, 0 fail**.
  `npm run typecheck` and `npm run build` exited 0.
- `npm test` is **not green**. The first candidate and baseline runs passed
  pretest then reached the same 360-second cutoff (exit 124) in the first Bun
  suite invocation, without a failed test. Because those runs discovered tests
  in a different order, the comparison was repeated with both exact source
  trees in the same disposable checkout slot (same dependencies, discovery
  order, environment, timeout, and `/dev/shm` `TMPDIR` and
  `MERIDIAN_E2E_SCRATCH`). Both again exited 124 at 360.01 s, in
  `antigravity-backend.test.ts` after passing `replays the same tool batch
  without generation, then rejects replay after its results arrive`. Baseline
  emitted two more passing tests there. The matched logs show 5107 candidate
  and 5108 baseline passing tests, zero failing lines before cutoff. This
  establishes the matched timeout exception, not a passing full suite or a
  permanent diagnosis of the suite's runtime.

Independent review and the conductor's integration/installation remain outside
this port. The installed package must be packed and named as the rollback
artifact before installation; the post-install cache gate still applies.
