# Per-game performance engine

> Status: implemented and unit-tested (detection, policy, activation/restore state machine,
> crash recovery). **Not yet exercised with a real game process** — see §9.

## 1. What it does

```
game takes focus ──► match profile ──► activate ──► game exits ──► restore
```

While a specific game is running, TuneSmith applies a small, reversible set of runtime
adjustments. When the game's process disappears, every one of them is undone.

The unit of work is a **session**, and the session is written to disk *before* the first
change, so the machine can always be returned to its previous state — even after a crash.

## 2. Why polling, not process hooking

The obvious implementation — inject a DLL, hook `CreateProcess`/`SetWinEventHook`, or
install a kernel callback — was rejected deliberately:

| Approach | Problem |
|---|---|
| DLL injection into the game | Anti-cheat (EAC, BattlEye, Vanguard) treats it as tampering; it can ban the user or refuse to launch |
| `SetWinEventHook` for foreground changes | Still needs an out-of-process injection or a native addon, and gives no process-exit signal |
| Kernel callback / driver | Requires a signed driver, disables Secure Boot trust assumptions, and is far outside a tuning app's remit |
| **Polling a CIM/`Get-Process` snapshot** | **Chosen**: no code enters the game process, nothing to ban, nothing to crash |

The watcher therefore observes from outside with two Win32 calls that only *read*:
`GetForegroundWindow` and `GetWindowThreadProcessId`, plus `Get-Process` for names and paths.
The only writes to the game process are `ProcessorAffinity` and `PriorityClass`, which are
documented, owner-permitted APIs — not injection.

A game is detected within one poll interval (default 2 s) of taking focus.

## 3. The watcher

```
main process ──spawn once──► powershell.exe (loop)
     ▲                              │
     │  one JSON line per tick      │  GetForegroundWindow → pid → exe/path/title
     └──────────────────────────────┘  Get-Process filtered to a watch list
```

Design points:

- **One persistent child, not one per tick.** Spawning PowerShell costs ~100 ms of CPU;
  doing that every 2 s would be indefensible in a tool that claims to make a machine
  faster. The loop idles in `Start-Sleep`.
- **The watcher knows nothing about policy.** It receives image names (validated by
  `PROCESS_NAME_RE`) and reports pids. Matching, budgeting and refusal all happen in the
  controller, so a compromised or buggy watcher cannot change the machine.
- **It is restarted with backoff** (1 s, 2 s, 5 s, 10 s, then give up and report
  unhealthy). A silently dead watcher that still claims "Watching" would be worse than none.
- **Payloads are line-delimited JSON**, so a partial write is discarded rather than parsed.

## 4. Adjustments

### 4.1 CPU affinity and priority

Mechanism: `System.Diagnostics.Process.ProcessorAffinity` / `.PriorityClass` — pure .NET, no
`Add-Type` compile, applied in a single call the moment the profile activates.

Affinity is expressed as a strategy, never a raw mask:

| Strategy | Selection |
|---|---|
| `all-cores` | every logical processor |
| `physical-cores` | first logical processor of each physical core (avoids SMT contention) |
| `performance-cores` | logical processors whose `EfficiencyClass` is the highest (P-cores) |
| `efficiency-cores` | the inverse, for background work |
| `custom` | explicit logical processor indices |

**Never an empty mask.** A process pinned to zero cores freezes; every strategy that
resolves to nothing falls back to all cores with a stated reason, which is surfaced in the
UI and the session log.

Hybrid classification uses `EfficiencyClass` from `GetSystemCpuSetInformation`, the same
field Windows uses for scheduling. Windows documents higher as more performant, which is the
default; `performanceClass: "lowest"` inverts it for a CPU that reports the opposite. When
every class is identical the CPU is reported as non-hybrid and hybrid strategies fall back
instead of guessing. `node scripts/topology.mjs` prints exactly what will be chosen.

Limitation: one processor group only, i.e. up to 64 logical processors. Above that the plan
is refused rather than misapplied.

### 4.2 GPU preference

Mechanism: `HKCU\SOFTWARE\Microsoft\DirectX\UserGpuPreferences`, value name = full
executable path, data = `GpuPreference=2;` (High performance) or `1;` (Power saving). This is
the same store the Windows *Settings → Display → Graphics* page writes.

- The path comes from the running process and is validated as an absolute drive path; a
  profile cannot supply it, so a preset cannot enumerate or probe arbitrary registry values.
- The previous value is captured (`null` when absent) and persisted **before** the write.
- Restore writes the previous string, or deletes the value if there was none — the same
  value both ways, so a stale entry never outlives the session.

### 4.3 Memory flushing — available, off by default

Mechanism: `NtSetSystemInformation(SystemMemoryListInformation = 80, command 4)`, with
`SeProfileSingleProcessPrivilege` enabled first. This purges the **standby list**, which is
what "free RAM" tools do.

It is off in every bundled profile on purpose, and the policy layer warns whenever a profile
enables it:

- The standby list is **cached file data**. Purging it means the game re-reads assets from
  disk, so load times usually get *worse*.
- Windows already trims standby pages when an application requests memory. Pre-emptively
  discarding them mostly makes the number in Task Manager look better.
- It needs elevation, and it is the one operation here that cannot be verified by a unit
  test (see §9).

If you want it, set `"flushStandbyMemory": true` and measure. The engine records whether the
purge succeeded and continues either way — it never blocks a session.

### 4.4 Background silencing

Two levels, in increasing order of intrusiveness:

| Action | Effect | Reversible |
|---|---|---|
| `lower-priority` | `Idle` or `BelowNormal` priority class | yes, captured priority restored on exit |
| `suspend` | `NtSuspendProcess` — the process stops executing | yes, `NtResumeProcess` on exit |

Rules are per image name (e.g. `chrome.exe`), applied to every matching process observed at
activation.

Guard rails:

- A **deny list** (`SUSPEND_DENYLIST`) covers the shell, compositor, audio engine, logon,
  authentication, service host and Defender. Suspending any of them freezes the desktop, so
  it is refused outright — not merely warned about.
- Launchers and overlays (Steam, Discord, OBS, NVIDIA) produce a **warning** when suspended:
  they are recoverable, but usually the wrong choice.
- `conservative` profiles may lower priorities but may not suspend anything.
- At most 12 processes may be suspended by one session.
- Every pid and its prior state is persisted before the suspend call.

### 4.5 Windows 11 Efficiency Mode (EcoQoS)

The `eco-mode` background rule is the middle ground between lowering a priority and
suspending a process: the process keeps running, but Windows is told to treat it as
expendable while the game is active.

Two mechanisms, one batched call (`src/main/platform/game/eco.ts`):

1. **Process throttle toggle.** `SetProcessInformation(hProcess, ProcessPowerThrottling, …)`
   with `PROCESS_POWER_THROTTLING_EXECUTION_SPEED |
   PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION`. The scheduler prefers efficiency
   cores for the process and stops letting it pin the timer resolution. Switching off
   clears the state mask, which is the EcoQoS half of the restore.
2. **Thread deprioritisation.** Every thread of the process is opened through a
   Toolhelp32 thread snapshot and parked with
   `SetThreadPriority(h, THREAD_MODE_BACKGROUND_BEGIN)`, which drops CPU, I/O and
   memory priority together. `THREAD_MODE_BACKGROUND_END` restores them on exit — this
   pair, not `TerminateProcess`, is why the operation is reversible.

(A naming note: `ProcessLeapSecondInformation` is a different information class —
leap-second data, not power. The EcoQoS knobs are `ProcessPowerThrottling` for processes
and `ThreadPowerThrottling` / `THREAD_MODE_BACKGROUND_*` for threads.)

**Auto-exclusion.** The deny list already covers the shell, compositor, audio engine
(`audiodg`, `audiosrv` — so a game profile cannot introduce audio crackling), logon,
authentication, service host and Defender; `powershell.exe`/`pwsh.exe` are also listed so
a profile can never blind the watcher itself. On top of the list, the controller filters
out its own process id, so the optimizer can never throttle itself even if a profile
names its executable.

**State restoration.** When the tracked game pid goes missing (after the two-tick
debounce that rides out a process restart), EcoQoS is switched off for every tracked pid
— throttling state cleared, all threads sent `THREAD_MODE_BACKGROUND_END` — before
priorities are restored and the GPU preference reverted. A pid that no longer exists is
ignored; a failed switch-off is recorded and keeps the session marked unrestored.

### 4.6 Timer resolution hold (`timerHold`)

Setting `"timerHold": true` holds the **global** Windows timer at its 0.5 ms floor for
the whole session via `NtSetTimerResolution(5000, TRUE)`, re-requested every 5 seconds
so driver activity cannot silently widen the quantum mid-match. This is the user-mode
analogue of the old `timeBeginPeriod` tricks, minus the orphaned-request failure mode:

- The request lives in a **detached holder child** (`src/main/platform/game/timer.ts`),
  not in the app process. The holder watches its parent pid and exits when the parent
  is gone, so a crash can never leave the machine pinned at 0.5 ms until reboot.
- Restore stops the holder explicitly (`timerHeld` in the session record); crash
  recovery needs no handle, because the watchdog has already done the job.
- Policy warns (`game.timer-hold`) because the global floor disables timer coalescing
  and raises idle power draw — that is the documented trade, accepted per session and
  released when the game exits.

### 4.7 Processor groups (more than 64 logical processors)

Windows caps a **processor group** at 64 logical processors. Threadripper PRO and
multi-socket machines are therefore split into several groups, and
`SetProcessAffinityMask` — the API behind `Process.ProcessorAffinity` — only ever affects
the process's *primary* group. Silently applying it there would pin a game to a fraction
of the machine.

TuneSmith models this explicitly:

- `CpuTopology.groups` lists each group with its active processor count and mask, read
  from `GetSystemCpuSetInformation`'s `Group` field (the same interop call that supplies
  `EfficiencyClass`).
- Logical processor indices in a profile are **global**: group offset plus index within
  the group. `custom: [0, 64]` on a two-group machine therefore means "one thread in each
  group", not "the same processor twice".
- A plan compiles to one mask **per touched group** (`AffinitySelection.groups`). One
  group keeps the cheap `ProcessorAffinity` path; two or more use
  `SetThreadGroupAffinity` on every thread, with each mask validated as a 64-bit value
  before it becomes a numeric literal.
- The documented 256-processor ceiling (4 x 64) is the only refusal left; above it the
  plan is refused rather than truncated.

Restoration is unchanged in kind: affinity is process state and dies with the process, so
there is nothing to undo on exit. A refused API call surfaces as a failed adjustment.

### 4.8 Microsoft Store / UWP titles

Store games run inside an AppContainer. Their install path is virtualised and the
executable can change between builds, so an image-name-only trigger is brittle and
`pathPrefix` is meaningless. The package family name (PFN) is the stable identity.

- **Watching.** The foreground watcher calls `GetPackageFamilyName` on the foreground
  pid (a `PROCESS_QUERY_LIMITED_INFORMATION` handle, no elevation) and reports
  `packageFamilyName` alongside the image name. A profile may declare `exe`, a
  `packageFamilyName`, or both; matching either identity is enough when both are present.
- **Resolution.** At watch start, each PFN named by a profile is resolved through
  `Get-AppxPackage` + `Get-AppxPackageManifest` (read-only, unelevated) to its
  `InstallLocation`, declared executables and AppContainer capabilities. The executables
  are added to the watch list so a title whose image name is not derivable from the PFN is
  still detected; capabilities are recorded for display. Manifest values are treated as
  untrusted input and normalised to bare `*.exe` names and identifier-shaped capability
  names.
- **What is skipped, and why.** Priority, affinity, suspension and Efficiency Mode work
  on an AppContainer process exactly as on a Win32 one (the handle is the same). The
  per-app GPU preference does not: it is keyed by executable path and Windows exposes no
  package equivalent, so the controller records a skipped `gpu-preference` adjustment
  with that reason instead of guessing a path. Policy warns about this combination up
  front.
- **Limits.** A package that is not installed for the current user simply does not
  resolve (logged, not fatal). Sideloaded/MSIX titles behave the same as Store ones;
  `SignatureKind` is recorded but never used to gate anything.

## 5. Crash and exit safety

The failure that matters is "the app died while Chrome was suspended". Three mechanisms
prevent it:

1. **Durable before mutate.** `GameSessionStore.save()` runs before `NtSuspendProcess` and
   before the GPU registry write.
2. **Recovery at startup.** `GameController.start()` reads unfinished session files and
   restores them, marking the session `interrupted` and surfacing a message if anything
   could not be undone.
3. **Quit is deferred.** `before-quit` prevents the quit, awaits `game.shutdown()` (resume,
   restore priorities, restore GPU preference), and only then quits.

Restore is **best-effort and total**: every step is attempted even if an earlier one failed,
because a partial restore is worse than a noisy one. Pids that no longer exist are ignored.

## 6. Policy summary

Structural (schema): bare `*.exe` image names, absolute install path prefix with no `..`,
printable window-title glob, ≤ 12 background rules, one rule per image, no `RealTime`
priority, suspend rules carry no priority and priority rules must carry one.

Semantic (`evaluateGameProfile`): protected trigger, protected background process, suspend
with `conservative` risk, suspension budget, affinity indices that do not exist on this
machine, processor groups > 64. Warnings: non-hybrid CPU with a P-core strategy, power-saving
GPU preference, standby flush, launcher suspension, timer hold (power cost).

A blocked profile is suppressed for as long as that executable stays in the foreground; it is
not retried every tick.

## 7. What this engine will not do

- Inject code, hook APIs, patch the game executable, or interact with anti-cheat.
- Kill processes (`suspend` is reversible; `TerminateProcess` is not).
- Add or start services, install drivers, or change boot configuration.
- Touch a process in another user's session.
- Persist anything about a game beyond the session record needed to undo it.

## 8. Files

```
src/shared/game/types.ts       domain types
src/shared/game/schema.ts      strict zod validation
src/shared/game/policy.ts      deny list, budgets, findings
src/shared/game/affinity.ts    mask computation and fallbacks
src/shared/game/matcher.ts     trigger matching
src/shared/game/describe.ts    UI labels
src/main/platform/game/scripts.ts   PowerShell/C# bodies (static)
src/main/platform/game/watcher.ts   persistent watcher with backoff
src/main/platform/game/control.ts   affinity, priority, suspend, GPU pref, purge
src/main/platform/game/eco.ts       EcoQoS efficiency-mode batch control
src/main/platform/game/timer.ts     crash-safe 0.5 ms timer holder child
src/main/platform/game/topology.ts  CPU sets + synthetic fallback
src/main/engine/game/store.ts       profile loading, session persistence
src/main/engine/game/controller.ts  state machine
presets/games/*.json                bundled profiles
tests/game-*.test.ts                engine tests (timer hold covered in tests/latency.test.ts)
```

## 9. Verification status

Tested (160 tests total):

- mask computation for SMT, hybrid, inverted classes, invalid custom indices, > 64 LPs;
- every policy rule, including the shell-suspend and shell-eco blocks;
- activation, GPU capture-before-write ordering, two-tick exit debounce, restore, manual
  stop, blocked profiles, crash recovery, switching game mode off;
- eco-mode apply and switch-off, failed eco restore surfacing, self-pid exclusion and
  Efficiency Mode on a denied or launcher process;
- timer hold: policy warning, UI label, holder script shape, activation recording,
  exit-time stop, and the unavailable-holder path;
- bundled profiles stay schema-valid and policy-clean.

Verified live (read-only):

- `node scripts/topology.mjs` on this machine: 12 logical processors, 6 physical cores,
  `source: cpuset`, SMT pairs correctly identified.

**Not verified:** an actual game launch → suspend → resume cycle, the standby purge, and
the timer hold. All three need a real game session with elevation, which is not something
a development run should perform unasked on a working machine. Treat the first session as
a supervised test: start with the esports profile, confirm the adjust/restore pair (including
the timer holder stopping on exit), and only then try a profile that suspends processes.

## 10. Extending

A new adjustment needs: a schema field, a policy rule, one adapter method, a step in
`activate()` that records an `AppliedAdjustment`, the matching undo in `restoreSession()`, and
a fake-adapter test that asserts the undo. If it cannot be undone, it does not belong in this
engine.
