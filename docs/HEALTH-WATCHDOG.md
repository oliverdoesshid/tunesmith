# System health watchdog

> Status: implemented and unit-tested. The live Windows probe was exercised on the
> development host; a real cumulative-update transition was not performed on it.

Windows updates can replace tuning targets after TuneSmith has applied a preset. The
watchdog observes that drift passively, without changing the machine:

```
startup ──► load baseline ──► probe ──► compare ──► notify
                 ▲                              │
                 └──── explicit “Mark reviewed” ┘

every 5 minutes ──► probe ──► compare ──► update status event
```

## 1. What is observed

| Input | How | Why |
|---|---|---|
| Windows build | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`: `CurrentBuildNumber`, `UBR`, `DisplayVersion` | a cumulative update changes the build or UBR |
| Servicing state | `Component Based Servicing\RebootPending`, `PackagesPending`, Windows Update `RebootRequired`, and `PendingFileRenameOperations` | catches staged updates and restart requirements before or after the reboot |
| Core system files | SHA-256, size and mtime of `ntoskrnl.exe`, `ntdll.dll`, `advapi32.dll`, `powrprof.dll` | detects replacement of the binaries whose behaviour tuning depends on |

The file list is deliberately small and fixed. This is not a System File Checker or a
general filesystem integrity product; running a full SFC scan or hashing the whole
Windows directory would be slow, noisy, and would need elevation. The four files above
are the minimum useful tripwire for the tuning engine.

A source that cannot be read adds a warning to the health status. It is never reported
as a clean check. A build change supersedes the file signal, so one cumulative update
produces one signal rather than five.

## 2. Baseline and review

The first successful probe is persisted at `<userData>/health/baseline.json` using an
fsync + atomic rename. The baseline is **not** advanced automatically: an update signal
would otherwise disappear on the next five-minute tick. It advances only when the user
chooses **Mark reviewed**, or when they explicitly accept the new state after recovery.

The baseline contains no secrets and no full file contents: build/servicing fields,
four path/size/mtime/hash records, warnings and a timestamp.

## 3. Pinned preset recovery

A preset can be pinned from its card in **Installed presets**. The id is stored in
`<userData>/health/settings.json`; the name and version are resolved from the current
signed/loaded preset library on each status read, so a removed preset is shown as
missing rather than presented as available.

**Re-apply pinned preset** opens the normal `PlanDialog` with a freshly compiled plan.
The existing gates still apply:

- hardware signature must match the plan;
- policy blockers and compatibility are re-evaluated;
- consent for restricted changes and risk acknowledgement for aggressive presets are
  required;
- an active game session must be stopped first.

There is intentionally no silent auto-apply. “One click” starts recovery; the final
confirmation is the same safety boundary as any other apply.

## 4. Stale journals

A journal is **stale** only when all of the following are true:

1. it is not `applying` and was not interrupted;
2. it has zero entries that are applied, pending, failed-but-unrestored, or otherwise
   still holding changes;
3. its manifest status is `rolled-back` or `failed`;
4. it finished more than seven days ago.

`rollback-failed`, `applied`, `applying`, and recent sessions are always retained. The
cleanup enumerates direct child directories, refuses invalid names, requires
`manifest.id === directory`, and only then removes the directory. It is an explicit
user action; there is no timer that deletes history.

## 5. Status and IPC

`health.status()` returns the current snapshot; `health.check()` probes immediately,
`health.acknowledge()` accepts the current observation as the baseline,
`health.pin()` stores a recovery preset, and `health.flushJournals()` performs the
restricted cleanup. `health:status-changed` pushes the same status to an open window.

## 6. Files and tests

```
src/shared/health/types.ts       status, signal and flush DTOs
src/main/health/probes.ts        build/servicing/file probes
src/main/health/compare.ts       baseline comparison policy
src/main/health/store.ts         atomic baseline/settings persistence
src/main/health/watchdog.ts      schedule, status, pin, acknowledge, cleanup orchestration
src/renderer/components/SystemHealthPanel.tsx  status and actions
tests/health-watchdog.test.tsx   comparison, persistence, pin, flush, fingerprint, panel
```

Tests cover: first-run baseline capture, OS/servicing/file signals, signal
acknowledgement, pin persistence, stale-only cleanup, and the panel actions. The live
probe on the development host read build `26300.9711`, all four file hashes, and
servicing state in about 98 ms with no warnings. A real update/reboot transition remains
a supervised test.
