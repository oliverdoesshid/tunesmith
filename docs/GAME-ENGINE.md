# Per-game performance engine

> Status: implemented and unit-tested (detection, policy, activation/restore state machine,
> crash recovery, non-hooking performance OSD, game-route TCP tuning, and the post-apply
> stability watchdog). **Not yet exercised with a real game process** — see §9.

## 1. What it does

```
game takes focus ──► match profile ──► activate ──► game exits ──► restore
```

While a specific game is running, TuneSmith applies a small, reversible set of runtime
adjustments. When the game's process disappears, every one of them is undone.

The unit of work is a **session**, and the session is written to disk *before* the first
change, so the machine can always be returned to its previous state — even after a crash.

## 2. Why observation, not injection

The obvious implementation — inject a DLL, hook `CreateProcess`, or install a kernel
callback — was rejected deliberately:

| Approach | Problem |
|---|---|
| DLL injection into the game | Anti-cheat (EAC, BattlEye, Vanguard) treats it as tampering; it can ban the user or refuse to launch |
| Kernel callback / driver | Requires a signed driver, disables Secure Boot trust assumptions, and is far outside a tuning app's remit |
| Polling a CIM/`Get-Process` snapshot | Keeps a CLR/PowerShell host waking every couple of seconds, even when no game is running; replaced |
| **`tasklist` for lifecycle + a read-only WinEvent observer** | **Chosen**: no code enters the game process, nothing to ban, nothing to crash |

Process presence comes from `tasklist`; focus, title and the foreground rectangle come from
read-only Win32 calls (`GetForegroundWindow`, `GetWindowThreadProcessId`, `GetWindowRect`).
The only writes to the game process are `ProcessorAffinity` and `PriorityClass`, which are
documented, owner-permitted APIs — not injection.

A focus change wakes the observer immediately and triggers a fresh `tasklist` scan, so game
detection does not wait for the two-second presence poll.

## 3. The watcher

```
main process ──execFile(/NH)──► tasklist.exe ── watched pids ──┐
     ▲                                                        │
     │  foreground JSON only when it changes                  │
     └── spawn once ──► powershell.exe (WinEvent observer) ────┘
```

Design points:

- **No polling CLR loop.** `tasklist /FO CSV /NH` is a short native process launched on the
  poll interval; the PowerShell-hosted observer installs WinEvent hooks and then blocks in
  `GetMessage`, so it has no periodic wakeups between focus, title or rectangle changes.
- **Cache and coalesce.** The last process list is reused for pure geometry changes; a
  coalesced observer line is emitted at most every 80 ms during a window drag. A foreground
  identity change triggers an immediate process scan instead of waiting for the next tick.
- **The watcher knows nothing about policy.** It receives image names (validated by
  `PROCESS_NAME_RE`) and reports pids. Matching, budgeting and refusal all happen in the
  controller, so a compromised or buggy watcher cannot change the machine.
- **Both halves fail loudly.** The foreground observer restarts with backoff (1 s, 2 s, 5 s,
  10 s, then gives up); the process scan retries with its own 1–10 s backoff. Either failure
  reports unhealthy, because a silently dead watcher that still claims "Watching" is worse
  than none.
- **Payloads are line-delimited JSON**, so a partial write is discarded rather than parsed.

### 3.1 Installed game discovery

Profiles can be selected by hand, but the app also discovers what is already installed and
matches those titles to local profiles. Discovery is a **read-only metadata scan**; it never
launches a game, executes a manifest value, or writes to a launcher directory.

| Source | What is read | Why this source |
|---|---|---|
| Steam | `steamapps/libraryfolders.vdf`, then `appmanifest_*.acf` in every library | covers secondary drives without assuming a single Steam root |
| Epic Games | `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` | the launcher's own install record, including `LaunchExecutable` |
| Xbox / Microsoft Store | `Get-AppxPackage` plus each package's app manifest | package identity and executable names; AppContainer install paths are virtualised |
| GOG | `HKCU` / `HKLM` `GOG.com\Games` registry entries | the per-title record written by GOG installers |

Executable discovery is bounded (2 MiB per manifest, 500 manifests, 800 directory entries,
three levels deep) and ranks candidates so helper binaries such as `unins000.exe` do not
become the mapped launch path. A manifest path that is absolute, contains `..`, or resolves
outside its install root is discarded. A source that fails is reported beside the results and
does not hide the other sources.

A discovered title is offered a profile only when the profile's executable name (or Store
package family name) and optional `pathPrefix` match the installed record. Matching is pure
and shared by the main process and the browser-preview mock. The renderer receives detected
titles, executable paths and matched profile ids through `game:libraries`; profile summaries
also carry `installed` and `detectedPath`. The result is cached for five minutes so opening the
profile list and the discovery panel does not launch duplicate PowerShell scans, and the UI
has an explicit **Rescan** action.

Limitations: Microsoft Store has no reliable "this package is a game" flag, so its scan
returns packages that declare an application executable and may include non-game apps; Steam
shortcuts that have no app manifest are not discoverable, and GOG is read from the registry
rather than Galaxy's private storage. None of the sources are mutated.

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

### 4.4.1 Automatic Cryo-Freeze

Cryo-Freeze is the opt-in automatic layer on top of the profile rules. It applies the same
`NtSuspendProcess` primitive and the same durable session record, but selects targets from a
fixed, code-owned allowlist (`src/shared/game/cryo.ts`) of cloud-sync clients, updater
processes and the Windows telemetry runner. The policy deny and caution maps are re-applied
before every activation, so a future edit cannot promote the shell, a security process or a
launcher into the list.

Behavior:

- The setting is global to Game Mode and applies to the next session; changing it while a
  session is active is refused, because silently unfreezing or freezing processes mid-game is
  worse than asking the user to restore first.
- Explicit profile `backgroundRules` win. If a profile already lowers, eco-modes or suspends an
  image, Cryo-Freeze does not also suspend it.
- A session starts for a matching profile as before. If the foreground executable belongs to a
  detected library game with no profile, the controller starts a Cryo-Freeze-only session, so
  a game does not need a bundled profile to receive the freeze layer.
- The automatic budget scales with the machine (2 / 6 / 12 processes for up to 4 / 8 / more
  logical processors), and the existing 12-per-session ceiling still applies.
- Candidates are observed at activation. A sync client or updater that starts later in the
  session is not retroactively frozen; this keeps the feature predictable and avoids polling
  and suspending newly launched work mid-game.
- Every automatic pid is written to the session before the suspend call, and restored through
  the same exit/crash-recovery path as profile suspensions.

Cryo-Freeze is *suspension*, not the EcoQoS `eco-mode` action in §4.5. Cloud sync pauses while
the game runs and resumes on exit; no file is closed, deleted or terminated.

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

### 4.9 Hardware triggers and thermal guards

Process focus is a proxy for load, and a poor one on a laptop: the game can be focused
while the package is at 96 °C and the firmware is already throttling. A profile may
therefore declare `guards` alongside its process trigger:

```json
"guards": {
  "maxCpuTempC": 90,
  "maxGpuTempC": 87,
  "onBattery": "restore",
  "cooldownSeconds": 180,
  "sampleSeconds": 10
}
```

- **Semantics.** A guard trips at or above its limit (`>=`, so 90 °C with a 90 °C limit
trips). A trip ends the session exactly like closing the game: affinity and priority are
not persisted, suspended processes resume, Efficiency Mode is cleared, the GPU preference
is restored and the timer holder stops. The session records a failed
`thermal-guard` adjustment quoting the reading, so the UI says *why* tuning released.
- **Cooldown.** After a trip the profile is not re-applied for `cooldownSeconds`
(default 120) even if the game stays focused. Re-tuning immediately after a thermal event
is the behaviour this feature exists to prevent. Activation is also refused outright if
the machine is already over its limit when the game is first focused.
- **Battery.** `onBattery: "restore"` releases the profile when the machine switches to
battery, which is what most gaming laptops do when the charger is pulled mid-session.
- **Sources, best first.** LibreHardwareMonitor, then OpenHardwareMonitor, are read
read-only through their WMI namespaces when either is already running. They are the only
sources here that report a true CPU package temperature, GPU temperature on NVIDIA, AMD and
Intel hardware alike, and real package power; installing one is the supported way to get
full coverage on a machine whose firmware exposes nothing. Without a monitor the chain falls
back to ACPI thermal zones (`MSAcpi_ThermalZoneTemperature`, then
`Win32_PerfFormattedData_Counters_ThermalZoneInformation`) for CPU — a *zone* reading, which
laptops usually expose and many desktops do not — and to `nvidia-smi` (including the legacy
NVSMI path) for NVIDIA GPUs. Power draw comes from the monitor when present, otherwise from
the battery discharge rate while on battery. AC state comes from `GetSystemPowerStatus` with
a `Win32_Battery` fallback, so desktops, laptops, handhelds and multi-GPU systems all take
the same path and simply report a shorter source list.
- **Provider selection is tested, not inferred.** The PowerShell side returns raw
candidates from every source; the preference order above lives in `normaliseTelemetry` and
has unit tests, so a switch to a better source cannot silently change behaviour on a
machine that has both.
- **Fail-open but loud.** A guard whose sensor is unavailable is never reported as passing
and never trips on a missing reading. If nothing at all can be read the session records
`Guard not enforced`; if only part can, it records `Partly enforced` once and keeps the
readable half active. A real trip always wins over a missing sibling sensor.
- **What it deliberately does not do.** Guards never edit the Windows power plan. Plan
changes belong to presets, which are captured and journaled; reaching into them from the
game engine would create a second mutation path that rollback does not cover.

### 4.10 Game-specific network route tuning

An optional `actions.network` block applies TCP latency values only to the interface that
is actually carrying the running game's server connection:

```json
"network": {
  "tcpAckFrequency": 1,
  "tcpNoDelay": 1,
  "interruptModeration": "disabled"
}
```

The three values are closed-vocabulary fields: `tcpAckFrequency` is 0, 1 or 2,
`tcpNoDelay` is 0 or 1, and `interruptModeration` is `enabled` or `disabled`. A profile
cannot name an adapter, an interface GUID, a registry path, a PowerShell command, or a
process. Schema validation rejects unknown keys and an empty network action.

**Discovery is read-only and OS-derived.** At activation, the platform layer asks Windows
for the game pid's established TCP connections (`Get-NetTCPConnection -OwningProcess`) and
bound UDP endpoints (`Get-NetUDPEndpoint`). It resolves each local address through
`Get-NetIPAddress` to an interface index, then `Get-NetAdapter` to the interface GUID and
adapter name. Loopback and wildcard addresses are discarded, as are rows that cannot be
mapped to a real adapter. Duplicate endpoints are removed and results are grouped by
interface. No game endpoint is hard-coded and no address is trusted as a registry key.

**Only relevant interfaces are touched.** TCP values are written only for interfaces with
at least one established TCP flow for this game. UDP-only gameplay has no per-interface TCP
stack value to tune; in that case the controller records an honest skipped adjustment, and
only the optional NIC property is attempted. Interrupt moderation is a single adapter
property and is applied to the first discovered route adapter. If the driver does not
expose `*InterruptModeration`/`InterruptModeration`, that part is skipped without failing
the rest.

**Capture, persist, then mutate.** The controller captures the current
`TcpAckFrequency`, `TCPNoDelay`, and (when exposed) the adapter's interrupt-moderation
registry keyword and value, writes the snapshot to `session.network`, and only then calls
the writer. A missing TCP value is captured as `null` and restored by deleting the value,
not by guessing a default. The NIC write uses `-NoRestart`; the driver may apply it on the
next adapter reset or reboot rather than instantly, and this is stated in the policy
warning. Restore is best-effort across every captured interface and the NIC; it runs even
when an earlier restore step failed, and crash recovery uses the same session record.

Limits: these are per-interface Windows TCP settings, not per-process packet steering.
While active they affect other TCP traffic on that interface too. They do not bypass the
game's network stack, inject a driver, or promise lower latency; they change acknowledged
delayed-ACK/Nagle behaviour and, where available, NIC interrupt coalescing. A machine that
requires elevation for adapter properties will record the failure instead of silently
claiming success. Bundled CS2 and Rainbow Six Siege profiles enable the block for their
moderate-risk sessions; a conservative profile may not use it.

### 4.10.1 Per-device MSI/MSI-X interrupt affinity (staged)

An opt-in Game Mode layer writes the documented Windows per-device interrupt-affinity
policy for three kinds of hardware:

| Target | Runtime enumeration | Why it is included |
|---|---|---|
| GPU | `Get-PnpDevice -Class Display`, PCI instance only | graphics ISR/DPC work benefits from a stable P-core set |
| NVMe controller | `Get-PnpDevice -Class SCSIAdapter` whose PnP service is `stornvme` | the storage interrupt path is latency-sensitive during streaming |
| NIC | `Get-PnpDevice -Class Net`, PCI instance only | network receive interrupts should not bounce across CCDs |

The engine writes two values under
`HKLM\SYSTEM\CurrentControlSet\Enum\<instance>\Device Parameters\Interrupt Management\Affinity Policy`:
`DevicePolicy = 4` (`IrqPolicySpecifiedProcessors`) and `AssignmentSetOverride`, a
little-endian 64-bit KAFFINITY mask. It does **not** write `DevicePriority`, change MSI
enablement, or name a registry path from a profile or the renderer.

**Mask selection.** `src/shared/game/interrupt-affinity.ts` selects one logical processor
per physical performance core on a hybrid CPU, or one per physical core otherwise. SMT
siblings are deliberately excluded, and the result is capped to one processor group. A
machine spanning more than 64 logical processors or more than one group is refused rather
than assigned to a guessed group. A device is eligible only when its
`MSISupported` value is already `1`; line-based shared IRQs are not pinned independently.

**Capture, persist, then write.** For every eligible device the platform layer reads the
current `DevicePolicy` and `AssignmentSetOverride` — including their registry type and
absence — and records them in `interruptAffinity` in the game session before the first
write. The allowed prior types are DWORD, QWORD and BINARY; any other type aborts capture,
because it could not be restored exactly. Restore rewrites the exact prior type/value or
deletes the value when it was absent, and checks that the PCI parent key still exists so a
removed device cannot cause a stale Enum key to be recreated. Every device is attempted even
if another failed, and crash recovery uses the same session record.

**Important Windows constraint.** The affinity policy is read when a device's resources are
assigned, which in practice means a device restart or reboot. There is no supported
user-mode API to move an already-running GPU, NVMe controller or NIC to a new interrupt set.
This build therefore **stages** the policy and never restarts those devices during play; it
restores the prior values on game exit. A running session's interrupt placement is unchanged
until Windows next starts the device, and the restored values are likewise read only at that
next start. The UI says this explicitly, and the write requires administrator rights; a
refusal is recorded as a failed adjustment rather than hidden.

This is separate from the `device-interrupt` preset action (MSI enablement) and the
`irq-priority` preset action (`PriorityControl\IRQ<n>Priority`). It is also separate from
process affinity: the game process may be pinned to the same P-cores, but the interrupt mask
is a machine-wide per-device policy rather than `SetProcessAffinityMask`.

### 4.11 Per-machine adaptation (no model, no background service)

A game profile is written for a class of machines, not for the one in front of it. At
activation the controller derives a small `MachineProfile` from facts detection already
produced — logical processors, physical cores, hybrid split, RAM tier and GPU kind — and
narrows the profile before applying anything:

| Condition | Adaptation |
|---|---|
| 6 or fewer logical processors, `performance-cores` / `physical-cores` | Use `all-cores`; pinning a small CPU starves Windows and input |
| 4 threads or fewer | At most 2 suspended background processes |
| 8 threads or fewer | At most 6 suspended background processes |
| Low tier (≤ 4 threads or ≤ 8 GB) with `timerHold` | Timer hold disabled; its power/heat cost outweighs the scheduling gain |
| Integrated / virtual / no GPU with `high-performance` | Preference skipped; it would have no effect |
| Unknown GPU, RAM or core facts | Nothing is guessed: the field stays as authored unless a rule has positive evidence |

Every adaptation is written into the session as an `adaptation` adjustment with the reason,
so the UI never silently drops a rule. Adaptation is a pure function over already-detected
data: **no AI model, no local inference server, no background process, and therefore
nothing running during a game session**. If a local model advisor is added later, it must
be gated on `GameController.hasActiveSession()` and unloaded when a session starts; this
build starts no such process.

Unknown hardware is a first-class case, not an error: topology-only facts still adapt
small CPUs, and a machine whose RAM or GPU cannot be read keeps its authored settings
rather than being guessed at.

### 4.12 Post-apply stability and thermal watchdog

Aggressive tuning presets are different from game-profile guards: they run after the apply
has completed, when no game session necessarily exists. `PostApplyWatchdog` therefore
monitors the applied session itself for five minutes, sampling every 15 seconds. It is
started only when a preset with `risk: aggressive` returns `status: applied`.

The watchdog acts through the normal transaction engine:

```
aggressive apply completes
        │
        ▼
PostApplyWatchdog (5 min, 15 s samples)
        │
        ├─ CPU or GPU > 90 °C ───────────────┐
        ├─ DPC % ≥ 8 for 2 samples ──────────┤
        └─ main-process stall > 15 s ───────┤
                                             ▼
                              Executor.rollback(sessionId)
                              (same journal path; no wait)
```

- **Thermal.** CPU and GPU temperature come from the same sensor chain as the game
  guards. A reading strictly above 90 °C trips immediately. Exactly 90 °C does not, matching
  the stated `>90 °C` threshold. Missing sensors are reported as unavailable, never as cool.
- **DPC pressure.** The probe reads Windows `% DPC Time` for the processor total from
  `Win32_PerfFormattedData_PerfOS_Processor` through CIM. It is a percentage of processor
  time, not a microsecond latency measurement; two consecutive samples at or above 8% trip.
  The UI labels it `DPC` and retains the source field.
- **Freeze warning.** The watchdog compares the expected sample time with the actual time.
  A stall longer than 15 seconds is treated as evidence of a system freeze and trips. A
  complete machine freeze can only be acted on after the process runs again; if the app is
  killed while frozen, the durable preset journal still holds the rollback records.
- **Automatic rollback.** A trip sets a visible `rolling-back` state and calls
  `Executor.rollback(sessionId)` immediately. There is no normal exit wait, no second
  mutation path, and no cache-clearing shortcut. A successful report becomes `rolled-back`;
  an incomplete report becomes `rollback-failed` with the errors, so the user is never told
  a failed restore succeeded.

The status is pushed over `engine:post-apply-status` and is also available on
`engine.postApply()`. A manual rollback, Restore to Default, or a new preset apply cancels
the previous monitoring window first. Monitoring runs in the main process while TuneSmith
is open; quitting the app ends the window, and the pre-existing applied session remains
available for manual rollback. The watchdog is an additional safety layer, not a claim that
an arbitrary aggressive preset can never destabilise a machine.

## 5. Crash and exit safety

The failure that matters is "the app died while Chrome was suspended". Three mechanisms
prevent it:

1. **Durable before mutate.** `GameSessionStore.save()` runs before `NtSuspendProcess`, the
   GPU registry write and the interrupt-affinity stage.
2. **Recovery at startup.** `GameController.start()` reads unfinished session files and
   restores them, marking the session `interrupted` and surfacing a message if anything
   could not be undone.
3. **Quit is deferred.** `before-quit` prevents the quit, awaits `game.shutdown()` (resume,
   restore priorities, restore GPU preference, restore per-interface network values and
   restore staged interrupt-affinity policy), and only then quits.

Restore is **best-effort and total**: every step is attempted even if an earlier one failed,
because a partial restore is worse than a noisy one. Pids that no longer exist are ignored.

## 6. Policy summary

Structural (schema): bare `*.exe` image names, absolute install path prefix with no `..`,
printable window-title glob, ≤ 12 background rules, one rule per image, no `RealTime`
priority, suspend rules carry no priority and priority rules must carry one.

Semantic (`evaluateGameProfile`): protected trigger, protected background process, suspend
with `conservative` risk, suspension budget, affinity indices that do not exist on this
machine, processor groups > 64, and network tuning in a conservative profile. Interrupt
affinity is a separate global toggle, not a profile action; it warns that administrator
rights and a device restart/reboot are required for the staged policy to take effect. Warnings:
non-hybrid CPU with a P-core strategy, power-saving GPU preference, standby flush, launcher
suspension, timer hold (power cost), network tuning (admin rights, per-interface scope,
UDP-only skip), and thermal limits tight enough to trip under ordinary load (CPU below
75 °C, GPU below 70 °C).

A blocked profile is suppressed for as long as that executable stays in the foreground; it is
not retried every tick.

## 7. What this engine will not do

- Inject code, hook APIs, patch the game executable, or interact with anti-cheat.
- Kill processes (`suspend` is reversible; `TerminateProcess` is not).
- Add or start services, install drivers, or change boot configuration.
- Restart a GPU, NVMe controller or NIC to force a newly staged interrupt-affinity policy.
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
src/shared/game/library.ts     installed-title to profile matching (pure)
src/main/platform/game/libraries.ts read-only Steam/Epic/Xbox/GOG discovery
src/main/services/artworkResolver.ts zero-key Steam local-cache + public-CDN resolver
src/main/services/steamgriddb.ts   legacy keyed SteamGridDB v2 search + bounded disk cache
src/main/services/game-files.ts    open/launch path validation against the scan
src/main/services/artwork-*.ts     ts-art protocol + image URL/type rules
src/renderer/components/GameLauncherGrid.tsx  library grid (cached art, launch, browse)
src/main/platform/game/scripts.ts   PowerShell/C# bodies (static)
src/main/platform/game/watcher.ts   tasklist poll + event-driven foreground observer
src/main/platform/game/control.ts   affinity, priority, suspend, GPU pref, purge
src/main/platform/game/eco.ts       EcoQoS efficiency-mode batch control
src/main/platform/game/timer.ts     crash-safe 0.5 ms timer holder child
src/main/platform/game/network.ts   read-only game-route discovery, TCP/NIC capture/apply/restore
src/shared/game/interrupt-affinity.ts  one-group P-core mask planning
src/main/platform/interrupt-affinity.ts  per-device GPU/NVMe/NIC PnP capture/apply/restore
src/main/platform/game/topology.ts  CPU sets + synthetic fallback
src/main/platform/game/frame-script.ts  static ETW present-sampler C# body
src/main/platform/game/frame-monitor.ts child wrapper + strict line parser
src/main/engine/game/store.ts       profile loading, session persistence
src/main/engine/game/controller.ts  state machine
src/main/engine/post-apply.ts       five-minute aggressive-apply watchdog -> journal rollback
src/main/platform/stability.ts      read-only temperature + DPC probe
src/shared/post-apply.ts            watchdog status DTOs (shared with renderer)
src/main/overlay/geometry.ts        OSD placement and display clamping
src/main/overlay/state.ts           GameStatus + frame sample -> display DTO
src/main/overlay/controller.ts      transparent OSD window lifecycle + anchoring
src/preload/overlay.ts              display-only bridge (onState)
src/renderer/overlay.tsx            OSD layout + browser-preview fixture
presets/games/*.json                bundled profiles
tests/game-*.test.ts                engine tests (timer hold covered in tests/latency.test.ts)
```

## 9. Verification status

Tested:

- discovery: VDF/ACF and Epic parsing, traversal rejection, executable ranking, source
  cache/in-flight sharing, Store/GOG normalisation, and profile suggestions;
- mask computation for SMT, hybrid, inverted classes, invalid custom indices, > 64 LPs;
- every policy rule, including the shell-suspend and shell-eco blocks;
- activation, GPU capture-before-write ordering, two-tick exit debounce, restore, manual
  stop, blocked profiles, crash recovery, switching game mode off;
- game network schema/policy, route capture ordering (capture and persist before apply),
  and restore through the game session; the real PowerShell discovery/write path is not
  exercised in unit tests;
- IRQ-affinity mask planning (SMT deduplication, hybrid P-cores, multi-group refusal),
  capture-before-apply ordering, session persistence, restore, the active-session toggle
  guard and the no-eligible-device skip; the live registry write/restore is not exercised;
- post-apply watchdog: CPU/GPU trip, two-sample DPC trip, freeze-sized stall, stable
  five-minute completion, manual cancellation, and the missing-sensor message;
- eco-mode apply and switch-off, failed eco restore surfacing, self-pid exclusion and
  Efficiency Mode on a denied or launcher process;
- Cryo-Freeze: candidate catalog policy filtering, profile-rule precedence, automatic budget,
  known-library-game activation without a profile, toggle guard during an active session,
  settings IPC, UI state, and restore through the durable session;
- timer hold: policy warning, UI label, holder script shape, activation recording,
  exit-time stop, and the unavailable-holder path;
- launcher path rules and IPC routing: traversal/UNC/device rejection, discovered-root folder
  matching, detected-executable containment, and missing-executable refusal;
- artwork metadata parsing, HTTPS host allowlist, magic-byte checks, cache restart, missing key,
  and retry after an outage (legacy SteamGridDB);
- zero-key Steam artwork: App ID validation, exact CDN URLs, local cache precedence, mixed
  local/CDN assets, placeholder on 404/outage, negative-cache expiry and request deduplication;
- bundled profiles stay schema-valid and policy-clean;
- OSD placement, state mapping, ETW line parsing, malformed-value rejection, and watcher
  geometry validation;
- ETW present sampling against a real presenting process: 144.0 FPS, 128.6 FPS 1% low,
  6.9 ms frame time (Chromium GPU process, so not a game).

Verified live (read-only):

- `node scripts/topology.mjs` on this machine: 12 logical processors, 6 physical cores,
  `source: cpuset`, SMT pairs correctly identified.
- ETW sampler live probe as above; the session started without elevation because this account
  is in `Performance Log Users`.

**Not verified:** an actual game launch → suspend → resume cycle, a real quick launch from the
launcher grid, the standby purge, the timer hold, a live SteamGridDB lookup, a live Steam CDN/local
cache round-trip, the live per-device interrupt-affinity registry write/restore and its post-reboot
interrupt placement, and an OSD window anchored over a real game (exclusive fullscreen is the main
risk). The game paths, including the affinity write, need a real session with elevation; the legacy
artwork path needs a live API key. None of these is something a development run should perform
unasked on a working machine. Treat the first session as
a supervised test: start with the esports profile, confirm the adjust/restore pair (including
the timer holder stopping on exit), and only then try a profile that suspends processes.

## 10. Extending

A new adjustment needs: a schema field, a policy rule, one adapter method, a step in
`activate()` that records an `AppliedAdjustment`, the matching undo in `restoreSession()`, and
a fake-adapter test that asserts the undo. If it cannot be undone, it does not belong in this
engine.

## 11. Launcher integration

The launcher is an entry point into this engine, not a second engine. `GameLauncherGrid` shows the
scanner's titles plus user-added manual entries and resolves Steam covers in bounded per-app
batches; it never executes or opens a path itself. Selecting a row opens the title's settings in
place; Game Mode does not repeat the library list. `game:pick-path` returns an opaque token plus
the selected path; `game:add-manual` accepts only those tokens, resolves them in main, applies the
same absolute-path/containment checks, and stores the entry in
`<userData>/games/manual-games.json`. The renderer never names a path in the add request.
`game:launch` re-resolves the title from the scan, requires a detected `.exe` inside its install
root, calls `setWatching(true)`, then `shell.openPath` on that executable. The watcher
then matches the foreground process exactly as it would if the user had launched the game from
Steam. `game:open-folder` similarly opens only a discovered install root. Path rules live in
`src/main/services/game-files.ts`; the Steam artwork resolver, legacy SteamGridDB cache and
`ts-art://` live in `src/main/services/`.

## 12. Performance OSD

The OSD is deliberately **not** an injected overlay. It is a second Electron
`BrowserWindow`: transparent, frameless, always-on-top, skip-taskbar, non-focusable and
click-through. It receives a display-only DTO over its own preload bridge (`onState` only),
so it has no app API, filesystem access, invoke surface or inbound IPC.

```
GameController tick ──► foreground pid + GetWindowRect
        │                        │
        │ status/telemetry       ▼
        └──────────────► GameOverlayController
                                 │  anchor to game rect (DIP conversion,
                                 │  clamp inside that display)
                                 ├──► transparent BrowserWindow
                                 └──► ETW child: DXGI Present #42 / D3D9 Present #1
                                          (10 s window; fps, worst-1% low, frame time)
```

The watcher reports the foreground window rectangle after opting into per-monitor DPI
awareness; the controller converts the physical rectangle with
`screen.screenToDipRect(null, rect)` so a game on a secondary display is scaled against the
correct monitor. The OSD is placed at the game's top-left with an 18 px inset and clamped
to the display bounds. It is shown only when the active session's pid still owns the
foreground window; otherwise it hides while ETW can keep sampling for a quick alt-tab.

The frame sampler uses ETW, not a hook: `Microsoft-Windows-DXGI` PresentStart (event 42)
for D3D10–12 and `Microsoft-Windows-D3D9` Present (event 1) for D3D9. A PowerShell/C# child
opens the real-time session, filters by pid, and computes FPS and the average of the slowest
1% of frame times over the last 10 seconds. The C# body is static and fed over stdin, so no
profile, process name or renderer string is ever concatenated into a command line. The
child has a parent watchdog and is stopped with the session.

Failure is explicit. If the ETW session cannot start (no elevation / not in `Performance
Log Users`), the OSD keeps showing the profile, adjustment counts and available temperatures,
and labels the FPS region `NO ETW` with the error. A `null` frame is never rendered as zero.

Limits: exclusive-fullscreen games may cover normal always-on-top windows, anti-cheat
policies vary, and ETW rights are environment-dependent. There is no DLL injection, no
game-memory read, and no write to the game process. `TuneSmithOsdApi` exposes only a
state subscription; toggle/status go through the narrow `game.osd` / `game:osd-set` IPC
channels, revalidated in main.
