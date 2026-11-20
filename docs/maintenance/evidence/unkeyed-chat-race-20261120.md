# Unkeyed Chat Completions recovery race — 2026-11-20

Branch `fix/unkeyed-chat-turn1-independent`, baseline `e58bc383`, runtime fix
`8805fe74`. Local only. The successful live driver ran on `5227fef3`; the
full wire matrix, typecheck and build ran on `8841c0dc` with the same source.
Linux x86-64, Bun 1.3.14, Node 22.23.4, Agent SDK 0.2.141, and production
Claude Code 2.1.322. See [the driver instructions](../../../E2E.md#concurrent-packed-first-turns).

## Regression and controls

- `bun test src/__tests__/passthrough-early-stop-integration.test.ts -t 'concurrent unkeyed packed chat'`:
  on the regression-only commit `2b2a2fea`, exit 1 (0 pass, 1 fail, 331
  filtered); two of three responses returned `api_error: Shared session
  mapping changed before recovery publication`. On the fix, exit 0 (1 pass,
  0 fail, 332 filtered); all three deliver their tool calls with no mapping.
- Full early-stop file: exit 0, 333 pass / 0 fail. The four existing keyed CAS
  cases still reject a lost publication/invalidation; a direct Messages
  request with a forged marker still resumes by fingerprint. The
  `independentRequestCause` filter passed 10 unit cases.
- Native negative control: invoke `scripts/e2e-offline-fresh-checkpoint.mjs`
  with `--unkeyed-chat --source-root=<e58bc383 archive> --claude=<production CLI>`.
  Exit 1: `SSE error: api_error (recovery publication conflict)`.
- `bun scripts/e2e-wire-matrix.mjs --claude=<production CLI>`: exit 0, **73/73**.
  `unkeyed-chat-parallel` asserted three new/independent first turns, three new
  derived tool-loop keys, and three continuing third rounds with the full R1
  system, tools and message prefixes. Nine loopback native requests and zero
  live model calls in this row. The matrix rejects any row without a zero-live
  summary. No existing R1 assertions were relaxed. The symlink spelling of
  the scratch path failed eight existing keepalive rows; `keepalive-text`
  failed on the baseline with that spelling too. Using the canonical tmpfs
  path passed all rows without changing the keepalive code or tests.
- `npm run typecheck` and `npm run build`: exit 0. `npm test`: pretest passed,
  but the first Bun invocation stopped the package command at **8,273 pass /
  28 skip / 4 fail** (exit 1, 8,305 tests across 490 files). Failures: the
  300 ms session-turn watchdog interrupted a seed request (499 instead of
  200), SQLite admission heartbeat gap (34.96 ms > 25 ms), deletion handshake
  timed out waiting for executor persistence, and a lost deletion lease. The
  three affected files pass on both baseline and candidate when run separately
  (23/18/4). The host was saturated (87–95% user CPU, 76–82 runnable on 64
  CPUs in a follow-up sample). The isolated passes do not clear the full-suite
  gate or prove the exact suite-level cause. No timing assertions or unrelated
  code changed; a clean full run is still required.

## Live evidence (sanitized)

An isolated built instance used the `personal` Claude Max login with
`fable[1m]` (production alias target `claude-fable-5-2`) and three concurrent
LiteLLM-shaped, unkeyed streaming conversations. The first probe stopped on
an overly strict single-tool-count assertion; the retained driver stages calls
by tool receipts and accepts a batch. The resulting nine requests all passed
and each third round read at least 90% of the preceding prompt, writing only
72 cache tokens. The probe exited 0 and its loopback listener closed;
production remained PID 409952, with the same active timestamp throughout.

```text
077b06c9-e2b1-4bef-a433-d303f5c11aeb-1-1 lineage=new diverged=independent-request:packed-chat profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=1k cache=34%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-1-2 lineage=new diverged=not-found profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=2k cache=27%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-1-3 lineage=continuation profile=personal model=fable[1m] usage: input=2 output=28 cache_read=2k cache_write=72 cache=97%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-2-1 lineage=new diverged=independent-request:packed-chat profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=1k cache=34%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-2-2 lineage=new diverged=not-found profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=2k cache=27%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-2-3 lineage=continuation profile=personal model=fable[1m] usage: input=2 output=21 cache_read=2k cache_write=72 cache=97%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-3-1 lineage=new diverged=independent-request:packed-chat profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=1k cache=34%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-3-2 lineage=new diverged=not-found profile=personal model=fable[1m] usage: input=2 output=54 cache_read=597 cache_write=2k cache=27%
077b06c9-e2b1-4bef-a433-d303f5c11aeb-3-3 lineage=continuation profile=personal model=fable[1m] usage: input=2 output=26 cache_read=2k cache_write=72 cache=97%
```

No push, PR, install, or production restart. For a future authorized install,
first `npm pack` the **installed** `@rynfar/meridian` tree (not the registry
version or this branch, even though the version string is the same). Name
that artifact `rynfar-meridian-1.89.0.tgz` in the rollback record. No pack
was created for this task.
