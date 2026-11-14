# Dead lifecycle owner recovery after restart (2026-11-14)

## Scope and diagnosis

Base: `fork/main` at `e1c37ba4f9a837fe898c28b1d5dadb0fcc17d563`.
Branch: `fix/session-gc-restart-lock`. No live service or cache mutation, model
calls, installation, publication or integration is part of this change.

Read-only incident command:

```sh
journalctl --user -u meridian.service --since '2026-11-14 02:35' --until '2026-11-14 02:50' -o short-iso
```

The host's journal renders local time at UTC-08:00. Decisive entries:

- 10:41:35Z: old Node PID 2208492 received SIGTERM.
- 10:41:38Z: `Error during shutdown: Proxy shutdown did not join admitted work
  before its deadline; ownership retained until cleanup settles`; main process
  exited with status 1. The replacement PID 473603 started the same second.
- 10:41:40.737Z: startup `session.gc_failed_closed`: `timed out waiting for
  /home/ras/.cache/meridian/session-gc.json.lock`.
- 10:41:53.477Z, 10:42:06.314Z and 10:42:30.942Z: three distinct request
  `error.unhandled` events with the same lock timeout (durations 2044, 2027 and
  2027 ms). The same requests also logged abandonment/GC failures; these are
  not additional distinct requests. Together with startup GC this gives four
  failed operations, not evidence of four distinct HTTP requests.
- 10:42:44.033Z: GC succeeded (`deleted:10, failed:0`). This is 63.296 seconds
  after the first startup failure, approximately 66 seconds after process exit.

`bin/cli.ts` exits with status 1 when `proxy.close()` rejects; it does not wait
for the still-admitted transaction's lock-release `finally`. A filesystem hard
link is not released by process exit. The journal therefore supports an
abandoned owner, not a live startup-maintenance holder. There is no surviving
incident lock inode/token to identify the interrupted transaction conclusively.
The November 13 journal has restarts at 19:00:44/45Z and 21:42:46/47Z with no
matching shutdown-deadline or lifecycle-lock timeout entries in that local day.

The existing lock's first line is JSON with `pid`, `hostname`, `token` and a
versioned `incarnation` (host, boot, PID, process-start ID); its second line is
creation time. Recovery already proves incarnation death (not just PID absence)
and serializes recoverers using a generation-specific recovery claim. However,
it checked mtime age against `DEFAULT_LOCK_STALE_MS = 60_000` **before** probing
the owner, and rechecked that age under the recovery claim. Each caller has only
`DEFAULT_LOCK_WAIT_MS = 2_000`. Thus a dead owner can block many callers until
its lock ages one minute. The recovery timing is consistent with this gate;
the exact incident mtime is unavailable.

## Change and safety boundaries

Remove only the two age predicates and their recovery argument. Reuse the
existing process-incarnation implementation; no new PID protocol, dependency,
startup hook or ownership format. Retain validation of `lockStaleMs` for caller
compatibility, documenting that it no longer delays proven-dead recovery.

Keep both death checks, the generation-specific recovery claim, content and
device/inode revalidation, quarantine, exclusive candidate link, cancellation
checks and token-checked release. Live, foreign, malformed and indeterminate
owners remain fail-closed irrespective of age. Transcript writer leases and
Windows descendant/reboot rules do not change. `maintenanceJournal.ts`'s
migration-specific `*.lock.releasing-<migration UUID>-<UUID>` records are a
different release path and require no change.

## Reproducible evidence

`src/__tests__/lifecycle-lock-restart.test.ts` is the escrowed isolated
cross-process reproducer. A child acquires the real lifecycle lock, exits from
inside its callback without running release, and a replacement registration
must recover it with **zero external-lock waiting budget**. This checks actual
acquisition rather than only a pure liveness helper. The live-owner case uses
a second real process, verifies its old lock cannot be taken, then terminates
only that disposable child and requires recovery even with a future mtime.
PID reuse and prior-boot cases use the existing incarnation probe. Negative
controls protect live, foreign and identity-less locks.

Before the fix:

```sh
bun test src/__tests__/lifecycle-lock-restart.test.ts
# exit 1: 3 pass, 4 fail; 15 assertions; 252 ms
```

All four positive recovery cases failed with the incident's lock-timeout error;
the three fail-closed controls passed.

After the fix:

```sh
bun test src/__tests__/lifecycle-lock-restart.test.ts src/__tests__/session-lifecycle.test.ts src/__tests__/process-incarnation.test.ts src/__tests__/lifecycle-lock-admission.test.ts src/__tests__/lifecycle-lock-deadline.test.ts src/__tests__/lifecycle-lock-queue.test.ts src/__tests__/session-lifecycle-process.test.ts
# exit 0: 102 pass, 0 fail; 389 assertions; 3.83 s (repeats: 3.97 s, 3.86 s)
npm run typecheck
# exit 0
npm run build
# exit 0; Node entrypoints certified
```

The fresh dead-process test took 63.95 ms including child startup and exit;
PID-reuse recovery took 3.51 ms; prior-boot recovery took 4.58 ms. These are
observations, not performance thresholds. Zero lock-wait budget is the test's
deterministic assertion that no retry/age delay is needed. Existing successor,
recovery-claim, cancellation, FIFO/deadline, process-incarnation and writer
lease tests are included in the 102-test run.

### Full-suite gate and baseline comparison (not green)

An initial foreground `npm test` was terminated by the command runner's
300-second timeout (exit 124), without a suite summary; this is not a pass.
The rerun in a task-owned transient user unit finished with **exit 1**:
**8242 pass, 28 skip, 3 fail**, 44,891 assertions, 8273 tests across 490 files
in 572.17 seconds. Its pretest typecheck passed. Because the first Bun group
failed, `npm test`'s later `&&`-chained isolated groups were not run. The initial
`systemd-run` client itself hit a 10-second tool timeout while waiting for the
oneshot unit; the unit continued, and its actual test exit was read separately.
These test units are unrelated to `meridian.service`.

Failures and discriminating checks:

1. `store-mutation-baseline.test.ts:116`: the warm write trace includes five
   extra lifecycle file operations. The exact same five operations occur with
   the original lock implementation.
2. `bookkeeping-runtime.test.ts:114`: offline migration detects a live
   `session-gc.json.lock.candidate-*` from its own test process. The same failure
   occurs with the original lock implementation.
3. `bookkeeping-runtime.test.ts:249`: heartbeat maximum gap was 27.709656 ms,
   exceeding the existing 25 ms limit. This case passed in the focused fixed
   run and in the full baseline run. Its original timing failure is not
   explained or claimed fixed.

```sh
bun test src/__tests__/store-mutation-baseline.test.ts src/__tests__/bookkeeping-runtime.test.ts
# fixed implementation: exit 0; 13 pass, 0 fail; 62 assertions; 915 ms (repeat: 918 ms)
```

For the baseline comparison, temporarily replaced only this worktree's
`src/proxy/sessionLifecycle.ts` with `git show e1c37ba4:src/proxy/sessionLifecycle.ts`,
ran `npm test`, and restored the exact fixed file through a shell EXIT trap.
No other checkout or branch was modified. New regression tests remained in
place as negative controls. Baseline **exit 1**: **8239 pass, 28 skip, 6 fail**,
44,888 assertions, 8273 tests across 490 files in 558.40 seconds. Four failures
are the new positive recovery cases, plus the same store-trace and migration
failures above. The heartbeat case passed. The first baseline launcher had no
login-shell PATH, so `npm` was not found (exit 127, no tests executed); its trap
restored the fixed source, and the actual baseline run used a login shell.

The two reproduced baseline suite failures and unexplained heartbeat variance
are left open rather than broadening the approved lock fix. The required full
suite is **not passing**, and no final-head CI or integration approval is
claimed. Focused checks, typecheck and build were repeated after restoring the
fixed implementation.

Validation environment: Linux, Node v22.23.4, Bun 1.3.14. Dependencies were reused read-only
via a worktree-local `node_modules` symlink; nothing was installed or changed
in the dependency tree. Affected-service restart/model/client E2E was not run:
the live service carries active sessions and restarting it is explicitly
prohibited. The regression crosses real OS processes and the implicated lock
implementation without contacting a provider. Full live-flow acceptance and
independent integration review remain with the parent; no independent review
is claimed by this engineer lane.
