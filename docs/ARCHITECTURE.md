# Architecture

> Status: foundational skeleton. It builds, typechecks, and its core logic is covered by
> 136 unit tests. It has not been run against a live Windows host for the *mutation* paths
> (see [Verification](../README.md#verification)), by design: no test suite in this repo is
> allowed to change the machine it runs on.

## 1. What this is

A Windows desktop application that applies community-authored performance presets, selected
by an exact hardware signature, with a rollback guarantee that survives a crash.

Three properties drive every design decision:

1. **A preset is data, never code.** There is a closed vocabulary of six action shapes. No
   preset can name an executable, a shell command, a raw registry hive, or a raw power GUID.
2. **Nothing is mutated before it can be undone.** A durable journal entry holding the exact
   prior state is written (and `fsync`ed) *before* the corresponding system call.
3. **Refusal is a valid outcome.** Anything that cannot be captured, parsed, matched, or
   verified is skipped with an explanation rather than attempted.

### Non-goals

Explicitly out of scope for this layer: driver installation, overclocking/undervolting,
boot configuration (BCD/HPET) changes, service *creation*, scheduled tasks, network *stack*
(driver bindings, provider order), kernel parameters, persistent background agents, auto-update,
and telemetry. Per-interface TCP acknowledgement values and MSI-X enablement are in scope
(requirement 8) because they are pure registry state with exact capture and restore; BCD edits
are not, because a wrong value bricks the boot and no journal can undo it.

## 2. Layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed, no Node)                                         │
│   App.tsx → HardwarePanel · PresetBrowser · PlanDialog · SessionPanel        │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  window.tunesmith (contextBridge, narrow API)
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ Preload (sandbox: true, contextIsolation: true)                              │
│   typed invoke wrappers; envelope unwrapping; no generic invoke escape hatch │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  ipcMain.handle + zod re-validation + sender check
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ Main process                                                                 │
│                                                                              │
│  engine/     preflight → compiler → executor → journal → lock               │
│  platform/   registry (reg.exe) · services (sc.exe) · power (powercfg.exe)   │
│              processes (PowerShell) · restore-point (PowerShell) · hardware  │
│  security/   CSP, navigation guards, permission denial                       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  Windows APIs via fixed, parameterised calls
┌───────────────────────────────┴──────────────────────────────────────────────┐
│ OS: registry · Service Control Manager · power subsystem · System Restore     │
└──────────────────────────────────────────────────────────────────────────────┘
Shared (pure, no Electron, no Node): signature · preset schema · policy · matcher ·
compiler · loader · session types. Used by main, renderer, CLI and tests alike.
```

### Module map

| Path | Responsibility | Depends on |
|---|---|---|
| `shared/signature.ts` | Canonicalisation rules + signature format (a versioned wire contract) | — |
| `shared/power.ts` | Curated power vocabulary with verified GUIDs | — |
| `shared/preset/schema.ts` | Structural validation (zod, strict objects) | zod |
| `shared/preset/policy.ts` | Semantic validation: registry tiers, protected services/processes, budgets | schema |
| `shared/preset/matcher.ts` | Hardware selector + profile-condition evaluation | signature |
| `shared/preset/compiler.ts` | Preset + machine → ordered, deduplicated, typed plan | schema, policy, matcher |
| `shared/preset/loader.ts` | Read, digest-verify, parse, policy-evaluate a preset library | schema, policy |
| `main/platform/*` | Thin adapters over one system tool each | — |
| `main/platform/interrupts.ts` | MSI-X / IRQ-priority / per-interface TCP capture-apply-restore | registry, powershell |
| `main/engine/journal.ts` | Append-only durable log + atomic manifests | node:fs |
| `main/engine/executor.ts` | Transaction: capture → journal → apply → verify → rollback | journal, lock, adapter |
| `shared/game/*` | Game profile schema, policy, affinity maths, trigger matching | shared |
| `main/platform/game/*` | Watcher, affinity/priority/suspend, CPU topology, GPU preference | platform |
| `main/engine/game/*` | Profile loading, session persistence, activate/restore state machine | platform/game |
| `main/ipc.ts` | Privileged surface: sender check, zod parse, error envelope | engine, platform |
| `renderer/*` | Presentation only; no privileged capability | shared types |

`engine/` and `platform/` never import `electron`. That is what lets the apply/rollback state
machine be tested in plain Node against a fake adapter.

## 3. Hardware detection

One PowerShell/CIM round trip collects raw material; all interpretation is pure TypeScript
(`interpretSnapshot`) so it is unit-testable.

Deliberate choices, each verified on a live Windows 11 host:

| Problem | What naive code does | What this code does |
|---|---|---|
| VRAM | `Win32_VideoController.AdapterRAM` is uint32, so a 12 GiB card reports `4,293,918,720` (~4 GiB) | reads `HardwareInformation.qwMemorySize` from the display driver key (`0x300000000` = 12 GiB) via two *targeted* `reg.exe` queries, and falls back to WMI only with `vramSource: 'wmi'` plus a warning naming the read failure |
| GPU choice | first `Win32_VideoController` entry wins | virtual adapters (`Meta Virtual Monitor`, `Virtual Desktop Monitor`, `Basic Display`) are classified and excluded; the discrete adapter with the most VRAM wins |
| SSD vs HDD | `Win32_DiskDrive.MediaType` returns "Fixed hard disk media" for both | `MSFT_PhysicalDisk.MediaType` via CIM (4 = SSD, 3 = HDD, 5 = SCM) plus a NVMe⇒SSD inference for `MediaType 0` |
| System disk | assumes disk 0 | resolves `MSFT_Partition.DriveLetter == $env:SystemDrive` → `DiskNumber` → physical disk |
| RAM | reports `31.92 GB` | buckets to the nearest standard tier (`32GB`), never snapping on a tie (a 6 GB machine stays 6) |
| Partial failures | one broken provider kills the report | each section is wrapped in `TryGet`, so a missing provider degrades to a warning |

### The signature is a wire contract

```
<cpu token>_<gpu token>_<ram token>_<drive token>
Intel_i7-14700K_RTX4070Ti_32GB_SSD
AMD_Ryzen5_5600X_RTX3060_32GB_SSD
```

Because the CPU token itself contains `_` (`Vendor_Model`), parsing works **from the right**:
the last three segments are drive, RAM and GPU; everything before them is the CPU token.

`SIGNATURE_VERSION` is stored in every preset and every detected spec. Changing a
canonicalisation rule without bumping it would silently stop matching existing presets, so it
is treated as a versioned public format, not a formatting detail.

## 4. Preset pipeline

```
index.json ─┐
            ├─► 1. integrity   sha256(file) == index entry?  ─┐
preset.json ┘                                                 │
                                                              ▼
                                    2. structural  zod strict objects, closed enums,
                                                   charset/length limits, no unknown keys
                                                              │
                                                              ▼
                                    3. semantic    registry tiers · protected services
                                                   · protected processes · budgets
                                                              │
                                                              ▼
                                    4. compile     select profiles → normalise actions →
                                                   dedupe → order → annotate risk
                                                              │
                                                              ▼
                                                    CompiledPlan (typed steps only)
```

Each stage can reject; none can mutate. A preset that fails stage 1–3 never becomes
applicable, and the UI shows why.

### Structural vs semantic — why two layers

- *Structural* answers "is this the document we designed?". Strict objects mean a preset
  cannot smuggle `execute: "..."` for a future engine version to honour.
- *Semantic* answers "may this document touch the OS?". It is a data table a reviewer can
  audit without reading execution code.

Between them they enforce: only `HKCU`/`HKLM`; only `REG_SZ`/`REG_EXPAND_SZ`/`REG_DWORD`/
`REG_QWORD`; no relative paths; bare `*.exe` (no paths) for processes; no `RealTime` priority;
at most 8 disabled services per profile, 120 actions per profile, 12 profiles per preset.

### The action shapes

| Shape | Maps to | Capture |
|---|---|---|
| `registry` set/delete | `reg.exe add` / `reg.exe delete` | current type + data, or "absent" |
| `service` startup/stop | `sc.exe config` / `sc.exe stop` | `START_TYPE` + running state |
| `priority` | `Get-Process`.PriorityClass (PowerShell) | per-PID current class |
| `power-plan` | `powercfg -setactive` | active scheme GUID |
| `power-setting` | `powercfg -setacvalueindex` + `-setactive` | value on the *captured* scheme |
| `device-interrupt` | MSI-X enable on enumerated PCI GPUs/NICs (`reg.exe` under `Enum\…\MessageSignaledInterruptProperties`) | per-device `MSISupported` + `MessageNumberLimit`, or "absent" |
| `irq-priority` | `PriorityControl\IRQ<n>Priority` | current DWORD, or "absent" |
| `network` | `TcpAckFrequency` / `TCPNoDelay` on every *active* TCP interface | per-interface DWORDs, or "absent" |

Everything is invoked with argv arrays and `shell: false`; the PowerShell paths use
`-EncodedCommand` (base64 UTF-16LE) with single-quote-escaped, regex-validated literals. No
preset string is ever concatenated into a command line.

## 5. Compatibility and conditional profiles

Matching is intentionally asymmetric: an unspecified dimension is a wildcard, but a specified
dimension that does not match makes the preset inapplicable.

```json
"compatibility": { "storage": ["SSD"], "ramGb": { "min": 16 }, "gpu": ["RTX4*"] }
```

A preset may also ship variants. A profile is active when its `when` clause matches **and**
its `extends` parent is active:

```
base (always) ──► high-refresh        when gpuVramGb >= 8 && cpuThreads >= 8
              └─► editing-suite       when gpuVramGb >= 12
```

Later profiles override earlier ones **by target**, not by append: the plan dedupes on
`hive\path\value`, `service:name`, `process:name`, `power:<setting>`, `msi:<class>`, `irq:<n>`, `network|tcp`. That makes "a variant
changes one value" expressible without repeating the whole profile.

## 6. Execution engine

### Invariants

1. **Durable before mutate.** Per step: `capture()` → `Journal.append(entry)` + `fsync` →
   `apply()` → `Journal.append(outcome)`. If the append throws, the mutation does not happen.
2. **Fail closed on unknown state.** If a value cannot be read — or is of a type outside the
   vocabulary, such as `REG_BINARY` — capture throws and the step is refused. Restoring an
   unknown prior value is impossible, so the change is not allowed.
3. **Any failure aborts the run and rolls back**, including the failed step itself (it may
   have failed *after* its first system call succeeded).
4. **Single writer.** A `mkdir`-based lock (`engine.lock/holder.json`) serialises sessions
   across windows and processes; a stale lock older than 10 minutes is broken once, loudly.

### Ordering

`Registry → Services → Priorities → Power`, and within Power the plan switch happens **before**
its per-setting values (a `powercfg` value index only takes effect on the active scheme).
The interrupt/TCP actions render in the Registry group and run after the raw registry writes:
devices and interfaces are enumerated at runtime, so they apply last, closest to the machine
they were captured from.

### Journal format

```
sessions/<uuid>/manifest.json     atomic (write tmp → rename)
sessions/<uuid>/journal.jsonl     append-only, one JSON record per line, fsync per record
```

```jsonc
{"type":"entry","seq":3,"at":"…","entry":{"target":"HKCU\\…\\GameDVR_Enabled",
  "before":{"kind":"registry","exists":true,"valueType":"REG_DWORD","data":1}}}
{"type":"outcome","seq":3,"status":"applied"}
{"type":"rollback","seq":3,"ok":true}
```

Append-only means a truncated trailing line loses at most one *outcome*, never the captured
prior state. An `entry` with no `outcome` is interpreted as "announced, probably applied" and
is rolled back conservatively.

### Crash recovery

A manifest stuck in `applying` is surfaced on the next launch and offered for restore. The
rollback path does not care *why* the session is incomplete: it replays every restorable entry
newest-first. Rollback is idempotent, so running it twice is safe.

### Rollback and "Restore to default"

- `rollback(sessionId)` restores entries newest-first and marks the session
  `rolled-back` or `rollback-failed`.
- `restoreDefaults()` rolls back **every** session that still has changes on the machine,
  newest first. This is the UI's one-click safety button.

### System Restore is the second line of defence

The journal makes undo take seconds. A restore point covers the case where the machine will
not boot far enough to run the app again.

`requires.restorePoint` is `required | preferred | none`:

| Mode | Behaviour |
|---|---|
| `required` | abort before any mutation if `Checkpoint-Computer` fails |
| `preferred` | continue with journal-only protection, and say so in the outcome |
| `none` | only legal for `conservative` presets (enforced by policy) |

Windows throttles checkpoints (`SystemRestorePointCreationFrequency`, 1440 minutes by
default). The app reports the throttle instead of disabling it: silently weakening a safety
net the user may rely on is worse than a skipped checkpoint with a clear message.

## 7. UI architecture

```
App (owns the state machine)
├── Header            signature chip · elevation badge · preview badge · refresh
├── SafetyBanner      renders preflight failures/warnings verbatim; offers elevation
├── HardwarePanel     CPU/GPU/RAM/storage/OS cards + copyable signature
├── PresetBrowser     search + filters (All/Compatible/Gaming/Workstation) + cards
│   └── PresetCard    risk badge, match score, step summary, blocked reasons
├── SessionPanel      session history + per-session Undo + "Restore to default"
└── PlanDialog        active profiles, grouped diff, safety notes, consent, progress
```

State transitions: `loading → ready → previewing → applying → ready`, with `error` as a
terminal toast. Progress arrives on a single push channel (`engine:progress`) and is rendered
as a labelled bar with `current/total`, which matters because a checkpoint can take 30 s.

The renderer is *presentation only*: every capability is a named method on
`window.tunesmith`, and each one is re-validated in main.

## 8. Data flow: applying a preset

```
renderer        main                         engine                 OS
   │  presets.plan(id)                                              
   ├──────────────►│ compilePlan(preset, spec)                      
   │               ├──► policy + matcher + dedupe                   
   │◄──────────────┤ CompiledPlan (blocked? consent needed?)        
   │  engine.apply(presetId, expectedSignature, acks)              
   ├──────────────►│ signature still matches? ──no──► reject        
   │               ├──► lock.acquire                                
   │               ├──► createSession(manifest)                     
   │               ├──► checkpoint ────────────────────────────────►│ Checkpoint-Computer
   │               ├──► capture ───────────────────────────────────►│ reg query / sc qc
   │               ├──► journal.append + fsync                      
   │               ├──► apply ─────────────────────────────────────►│ reg add / sc config
   │◄──progress────┤                                                
   │               ├──► finalize('applied')                         
   │◄──────────────┤ ApplyOutcome                                   
```

## 9. Failure modes

| Failure | Detection | Result |
|---|---|---|
| Preset tampered with | sha256 vs index | preset not listed as applicable |
| Unknown JSON key | strict schema | schema rejection with a field path |
| Blocked registry key | policy tier | plan `blocked`, Apply disabled |
| Prior state unreadable | capture throws | step refused, run aborts, nothing changed for that step |
| Journal unwritable | preflight + append failure | no mutation attempted |
| Step fails mid-plan | apply throws | auto-rollback of every restorable step |
| Process killed mid-apply | manifest `applying` | surfaced next launch; conservative rollback |
| Restore point throttled | checkpoint result | `preferred`: continue + disclose; `required`: abort |
| Two sessions | lock holder | second is rejected with the holder's pid |
| Renderer compromised | sender check + zod | request rejected; no privileged capability exposed |

## 10. Testing

- **Pure logic** (signature, schema, policy, matcher, compiler) is tested directly.
- **Executor** is tested against a `FakeAdapter`, covering: happy path, failure mid-plan with
  reverse rollback, capture refusal, restore-point abort, idempotent rollback, crash recovery
  of an announced-but-unfinished step, and `restoreDefaults` across sessions.
- **Loader** is tested against a temp directory with a generated index, including digest
  mismatch, unlisted-file smuggling, and duplicate ids.
- **Shipped presets** are loaded and policy-checked in CI: the library cannot regress into a
  blocked state.

## 11. Extension points

1. **New action type** (e.g. scheduled task): add a schema shape, a platform adapter, a
   policy rule, and a test. The executor switch is exhaustive, so TypeScript will point at
   every place that needs updating.
2. **New power setting**: verify the GUID with `powercfg -query` on a real machine first;
   hidden settings cannot be captured and must not be added.
3. **Signed preset distribution**: replace the trust level `bundled-verified` with an Ed25519
   signature check over the manifest (see `SECURITY-MODEL.md`).
4. **Non-Windows**: `interpretSnapshot` is already platform-neutral; the adapters are not.

## 12. Per-game runtime engine

A second, shorter-lived kind of session: while a specific game has focus, a profile applies
affinity/priority, a per-app GPU preference, optional background silencing, and restores
everything when the process exits. It shares the durable-before-mutate invariant but keeps its
own session store, because its lifecycle is "until the game closes" rather than "until the user
rolls back".

Detection is polling, not injection: no code enters the game process, so anti-cheat sees
nothing to ban. Full design, deny list and verification status: `docs/GAME-ENGINE.md`.

## 13. Deliberate exclusions

| Excluded | Why |
|---|---|
| `REG_BINARY`, `REG_MULTI_SZ` | ambiguous `reg.exe` encodings; no mainstream tweak needs them |
| `RealTime` priority | starves input/audio threads; cannot be made safe |
| Raw `powercfg` GUIDs from presets | vocabulary drift and auditability |
| Direct writes under `HKLM\SYSTEM\CurrentControlSet\Services` | bypasses SCM dependency checks; use the service action |
| Registry path `Session Manager` | boot-time file operations (`PendingFileRenameOperations`) are an arbitrary-file-move primitive |
| Service creation | a preset must not be able to install a service |
