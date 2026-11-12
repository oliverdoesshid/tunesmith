# Architecture

> Status: foundational skeleton. It builds, typechecks, and its core logic is covered by
> 427 unit tests across 44 files. It has not been run against a live Windows host for the *mutation* paths
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
(driver bindings, provider order), kernel parameters, persistent background agents, and
telemetry. Per-interface TCP acknowledgement values, MSI-X enablement and per-device
interrupt-affinity policy are in scope (requirement 8) because they are pure registry state
with exact capture and restore; the affinity engine stages policy for the device's next start
rather than restarting live hardware. BCD edits are not in scope, because a wrong value bricks
the boot and no journal can undo it.

## 2. Layers

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed, no Node)                                         │
│   App.tsx → HardwarePanel · PresetBrowser · InstalledPresets · PlanDialog    │
│             GameLauncherGrid · ShaderCachePanel · SystemHealthPanel          │
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
│  services/   artwork resolver · shader-cache fixed-root health/prune         │
│  updater.ts  packaged GitHub Releases check · download status · install      │
│  overlay/    transparent, click-through OSD window (separate renderer)        │
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
| `shared/service-graph.ts` | Bounded, read-only SCM dependency tree for service actions | policy, session types |
| `shared/market/*` | Signed in-app catalog types plus the static Pages index schema and URL rules | zod |
| `scripts/generateMarketIndex.ts` | Verifies community preset digests/signatures and emits `market/index.json` | shared/market, security/keys |
| `market/` | Dependency-free GitHub Pages storefront and generated public catalog | — |
| `main/platform/*` | Thin adapters over one system tool each | — |
| `main/platform/interrupts.ts` | MSI-X / IRQ-priority / per-interface TCP capture-apply-restore | registry, powershell |
| `main/platform/service-registry.ts` | Fixed read-only SCM inventory + zod-normalised rows | powershell, zod |
| `main/engine/journal.ts` | Append-only durable log + atomic manifests | node:fs |
| `main/engine/executor.ts` | Transaction: capture → journal → apply → verify → rollback | journal, lock, adapter |
| `shared/game/*` | Game profile schema, policy, affinity maths, trigger matching, library matching | shared |
| `main/platform/game/*` | Watcher (`tasklist` + event-driven foreground), affinity/priority/suspend, CPU topology, GPU preference, read-only library discovery | platform |
| `main/engine/game/*` | Profile loading, session persistence, activate/restore state machine | platform/game |
| `main/platform/game/network.ts` | Game-route discovery; per-interface TCP and NIC capture/apply/restore | interrupts, powershell |
| `main/platform/interrupt-affinity.ts` | GPU/NVMe/NIC PnP enumeration; per-device affinity-policy capture/apply/restore | registry, powershell |
| `shared/game/interrupt-affinity.ts` | One-processor-group physical P-core mask planning | shared/game/affinity |
| `main/platform/stability.ts` | Read-only temperature and Windows `% DPC Time` probe | platform/game |
| `main/engine/post-apply.ts` | Five-minute aggressive-apply watchdog; calls the journal rollback path | engine/executor |
| `shared/post-apply.ts` | Post-apply watchdog DTOs shared by main and renderer | shared |
| `main/health/*` | Health baseline, read-only OS/file probes, drift comparison, stale-journal cleanup | platform, engine/journal |
| `shared/game/artwork.ts` | SteamGridDB and zero-key Steam artwork DTOs | — |
| `main/services/steamgriddb.ts` | SteamGridDB search/artwork fetch, strict parsing, disk cache | zod, artwork-files |
| `main/services/artworkResolver.ts` | Local Steam cache scan, Valve CDN URLs/probes, placeholder chain, memory cache | shared/game/artwork |
| `main/services/artwork-files.ts` | HTTPS host allowlist, cache path mapping, image magic-byte checks | — |
| `main/services/artwork-protocol.ts` | Private `ts-art://` protocol serving cached images | electron |
| `main/services/game-files.ts` | Open/launch validation against discovered install roots | shared/game |
| `shared/shader-cache.ts` | Closed cache ids, health DTOs and the prune request/result contract | — |
| `main/services/shader-cache.ts` | Fixed LocalAppData scan, DirectX `app_id` orphan analysis, whole-file prune | node:fs, node:sqlite |
| `shared/updater.ts` | Display-only update phase/status DTO | — |
| `main/updater.ts` | Packaged-only GitHub Releases check, download events and install handoff | electron-updater, electron-log |
| `shared/game/osd.ts` | Display-only OSD DTOs and the `onState` bridge type | — |
| `main/platform/game/frame-script.ts` | Static ETW present-sampler C# body, DXGI/D3D9 providers | — |
| `main/platform/game/frame-monitor.ts` | Child lifecycle, line parsing, explicit unavailable state | frame-script |
| `main/overlay/geometry.ts` | Pure placement/clamping in DIP space | — |
| `main/overlay/state.ts` | `GameStatus` + frame sample → `OsdState` | shared/game |
| `main/overlay/controller.ts` | Transparent BrowserWindow, anchoring, ETW lifecycle, toggle | electron, platform/game |
| `preload/overlay.ts` | Display-only bridge; no invoke, no app API | shared/game/osd |
| `renderer/overlay.tsx` | OSD layout and browser-preview fixture | shared/game/osd |
| `renderer/components/GameLauncherGrid.tsx` | Steam cover ledger, per-app lazy resolution, loading plates, error boundary | shared/game, preload |
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
| `power-setting` | `powercfg -setacvalueindex` + `-setactive` | value on the *captured* scheme; hidden EPP/core-parking values via `PowerReadACValue` |
| `device-interrupt` | MSI-X enable on enumerated PCI GPUs/NICs (`reg.exe` under `Enum\…\MessageSignaledInterruptProperties`) | per-device `MSISupported` + `MessageNumberLimit`, or "absent" |
| `irq-priority` | `PriorityControl\IRQ<n>Priority` | current DWORD, or "absent" |
| `network` | `TcpAckFrequency` / `TCPNoDelay` on every *active* TCP interface | per-interface DWORDs, or "absent" |

Everything is invoked with argv arrays and `shell: false`; the PowerShell paths use
`-EncodedCommand` (base64 UTF-16LE) with single-quote-escaped, regex-validated literals. No
preset string is ever concatenated into a command line.

### Service dependency preview

`presets:service-dependencies` is a separate read-only request: it takes only a preset id,
recompiles the plan, and reads the service keys named by that plan. A fixed PowerShell pass
collects `DependOnService` / `DependOnGroup`; the pure graph builder caps depth, branch count
and total nodes, marks cycles and missing targets, and aggregates protected dependents. The
result is advisory. It is never used by the executor, which still captures through `sc.exe`
before mutating, and protected targets remain policy-blocked.

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
4. **Single writer.** A `mkdir`-based lock (`sessions/lock/holder.json`) serialises sessions
   across windows and processes; a stale lock older than 10 minutes is broken once, loudly.
   A lock directory with no holder record is only broken once its directory mtime is stale,
   closing the window between `mkdir` and writing `holder.json`.

### Ordering

`Registry → Services → Priorities → Power`, and within Power the plan switch happens **before**
its per-setting values (a `powercfg` value index only takes effect on the active scheme).
The interrupt/TCP actions render in the Registry group and run after the raw registry writes:
devices and interfaces are enumerated at runtime, so they apply last, closest to the machine
they were captured from.

### Journal format

```
sessions/<uuid>/manifest.json     atomic (fsync tmp → rename → fsync dir where supported)
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
├── PresetBrowser     community marketplace: search, tag filters, compatibility badges
│   └── CatalogCard  verified SHA-256/Ed25519 chip, install, safety score
├── InstalledPresets  search + filters for the locally installed library
│   └── PresetCard    risk badge, match score, step summary, blocked reasons
├── GameLauncherGrid  installed-title grid · Steam cache/CDN covers · Play · Browse local files
├── GameModePanel     watcher status · OSD toggle · detected libraries · installed profiles
├── SessionPanel      session history + per-session Undo + "Restore to default"
└── PlanDialog        active profiles, service dependency trees, grouped diff, notes, consent, progress
```

State transitions: `loading → ready → previewing → applying → ready`, with `error` as a
terminal toast. Progress arrives on a single push channel (`engine:progress`) and is rendered
as a labelled bar with `current/total`, which matters because a checkpoint can take 30 s.

The renderer is *presentation only*: every capability is a named method on
`window.tunesmith`, and each one is re-validated in main.

The performance OSD is a second renderer with a deliberately smaller bridge. `overlay.html`
loads `renderer/overlay.tsx` and `preload/overlay.ts`; that preload exposes only
`onState(listener)` from `TuneSmithOsdApi`, with no `invoke`, filesystem or app API. The main
process creates the window only when an active game is in the foreground and sends it a
read-only `OsdState` snapshot.

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
| Steam cache and CDN empty | placeholder result | generated plate stays; no error toast |
| Steam CDN unreachable | placeholder + short negative cache | plate stays; retry after 60 s |
| Invalid Steam App ID | zod + resolver validation | placeholder; no filesystem or network access |
| SteamGridDB key missing (legacy) | batch `configured:false` | placeholders + one setup notice; no requests |
| Game folder vanished | `stat` before `openPath` | error response; nothing opened |
| No detected executable | Play disabled; main refuses | watcher not armed |
| No game TCP server route | interface discovery returns empty | network adjustment recorded as skipped; no idle interface is touched |
| Post-apply temperature / DPC / stall trip | watchdog probe or timer drift | immediate journal rollback, visibly reported; no exit wait |

## 10. Testing

- **Pure logic** (signature, schema, policy, matcher, compiler) is tested directly.
- **Executor** is tested against a `FakeAdapter`, covering: happy path, failure mid-plan with
  reverse rollback, capture refusal, restore-point abort, idempotent rollback, crash recovery
  of an announced-but-unfinished step, and `restoreDefaults` across sessions.
- **SessionManager** is tested with real journal files: atomic manifest writes, startup scan
  of unclosed sessions, newest-first recovery of applied, failed, and announced-without-outcome
  steps, and stale-lock takeover. A component test covers the interrupted-session banner and
  its one-click restore callback.
- **Loader** is tested against a temp directory with a generated index, including digest
  mismatch, unlisted-file smuggling, and duplicate ids.
- **Game launcher** is tested at three boundaries: path rules (traversal/UNC/device/stream
  rejection, case-insensitive discovered-root matching, executable containment), IPC routing
  (sender check, strict payloads, native-picker token redemption, open/launch dispatch), and
  SteamGridDB parsing/caching (fixtures, magic bytes, host allowlist, cache restart, missing key,
  retry after an outage). The manual store is exercised against real temp files, including
  duplicate/outside-root rejection and refusing to overwrite a malformed list. Cryo-Freeze is
  covered at the controller boundary: candidate policy filtering, profile precedence, the
  machine-sized budget, generic library-game activation, the active-session toggle guard, and
  restore through the session file.
- **Zero-key Steam artwork** is tested against a real temp cache and a fake CDN: App ID validation,
  exact CDN URLs, local `file://` precedence, mixed local/CDN assets, HEAD 404 and outage
  placeholders, negative-cache expiry, and concurrent-request deduplication.
- **Shipped presets** are loaded and policy-checked in CI: the library cannot regress into a
  blocked state.
- **Performance OSD** geometry, state mapping, ETW line parsing, malformed-value rejection and
  watcher window geometry are tested in `tests/game-overlay.test.ts`. The live ETW path was
  exercised against a presenting Chromium process (144 FPS, 128.6 1% low).
- **Game network and post-apply watchdog** are covered by schema/policy tests, a fake-adapter
  capture-before-apply/restore test, and deterministic watchdog tests for thermal, DPC,
  freeze, stable, cancel and missing-sensor paths.
- **IRQ affinity** is covered at the pure planner, controller and IPC/UI boundaries:
  SMT deduplication, hybrid P-core selection, multi-group refusal, capture-before-apply
  ordering, session persistence, restore, active-session toggle guard and no-device skip.
  The live PnP affinity write/restore was not run in the test suite.

## 11. Extension points

1. **New action type** (e.g. scheduled task): add a schema shape, a platform adapter, a
   policy rule, and a test. The executor switch is exhaustive, so TypeScript will point at
   every place that needs updating.
2. **New power setting**: verify the GUID with `powercfg -query` on a real machine first;
   hidden settings cannot be captured and must not be added.
3. **Signed preset distribution**: implemented for the marketplace
   (`src/main/market/`, `docs/MARKETPLACE.md`) with Ed25519 over a canonical catalog and
   per-entry digests. Bundled presets still use the index digest, which is integrity, not
   authorship.
4. **Non-Windows**: `interpretSnapshot` is already platform-neutral; the adapters are not.

## 12. Per-game runtime engine

A second, shorter-lived kind of session: while a specific game has focus, a profile applies
affinity/priority, a per-app GPU preference, optional background silencing, optional
game-route network TCP/NIC tuning, and optional per-device GPU/NVMe/NIC interrupt-affinity staging,
then restores everything when the process exits. Network values are captured per discovered
interface into the game session before mutation; the profile never names an adapter or
registry path. Interrupt-affinity devices are likewise enumerated at runtime and every prior
policy value is written to the session before mutation. It shares the durable-before-mutate
invariant but keeps its own session store, because its lifecycle is "until the game closes"
rather than "until the user rolls back".

After a successful aggressive *preset* apply, a separate five-minute watchdog samples thermal
and DPC data. A temperature above 90 °C, sustained DPC pressure, or a freeze-sized process
stall invokes `Executor.rollback()` through the existing journal; it does not write to the OS
directly.

Detection is polling, not injection: no code enters the game process, so anti-cheat sees
nothing to ban. Installed titles are found separately by a bounded, read-only scan of Steam,
Epic, Xbox and GOG metadata; matches are suggestions, not automatic activation. Full design,
deny list and verification status: `docs/GAME-ENGINE.md`.

## 13. Deliberate exclusions

| Excluded | Why |
|---|---|
| `REG_BINARY`, `REG_MULTI_SZ` in the **preset action vocabulary** | ambiguous `reg.exe` encodings; no mainstream preset tweak needs them. The interrupt-affinity snapshot handles REG_BINARY internally through a narrowly scoped PowerShell value reader/writer. |
| `RealTime` priority | starves input/audio threads; cannot be made safe |
| Raw `powercfg` GUIDs from presets | vocabulary drift and auditability |
| Direct writes under `HKLM\SYSTEM\CurrentControlSet\Services` | bypasses SCM dependency checks; use the service action |
| Registry path `Session Manager` | boot-time file operations (`PendingFileRenameOperations`) are an arbitrary-file-move primitive |
| Service creation | a preset must not be able to install a service |

## 14. System health watchdog

A passive, read-only monitor compares the current Windows build/UBR, servicing flags and
four core system-image hashes against a baseline under userData. Drift is pushed to the UI;
it never applies a preset or rewrites a journal automatically. Recovery runs through the
existing preview, signature, consent and risk gates. Cleanup is an explicit action and only
removes old, finished journals with zero pending rollback entries. Full design and threat
notes: `docs/HEALTH-WATCHDOG.md`.

## 15. Game launcher and artwork

The library grid is presentation over the read-only scanner and the small persisted manual-entry
store, plus privileged actions that resolve and validate their targets in main. Selecting a row
opens that title's settings in place; the duplicate library list was removed from Game Mode.

- **Browse local files.** `game:open-folder` takes an absolute path, but the handler resolves it
  against the cached library scan and opens only a discovered `installDir` with
  `shell.openPath`. UNC/device paths, `..` segments, alternate data streams and unknown folders
  are rejected before `stat` or `shell.openPath` is called.
- **Add a local title.** `game:pick-path` opens the native folder/executable picker and mints an
  opaque token for the selected path. `game:add-manual` accepts only those tokens, resolves them
  in main, applies the same absolute-path and containment checks, and persists the entry under
  `<userData>/games/manual-games.json`. The renderer never submits a path.
- **Cryo-Freeze.** An opt-in game-mode layer suspends a fixed allowlist of cloud-sync,
  updater and telemetry processes through the existing durable session path. Profile rules take
  precedence for any image they already manage. A detected library game without a profile runs
  a Cryo-Freeze-only session, so the feature is not limited to bundled profiles. The setting is
  rejected while a session is active; the next session uses the new value.
- **IRQ affinity.** An opt-in layer enumerates PCI Display, NVMe (`stornvme`) and Net devices,
  filters to MSI-enabled hardware, and stages `DevicePolicy`/`AssignmentSetOverride` on one
  physical performance core per selected core. The renderer supplies only a boolean. The
  session stores every prior registry type/value (including absence) before the first write;
  restore and crash recovery use that snapshot. Windows reads this policy at device start, so
  no GPU/NVMe/NIC is restarted during play, and the UI says the change is staged.
- **Quick launch.** `game:launch` takes a library id. The handler resolves the title from the
  scan (including manual entries), requires one of its detected executables inside its install
  root, arms the profile watcher (`setWatching(true)`) and only then calls `shell.openPath` on
  that `.exe`. MSIX titles with no directly launchable executable are refused with an explanation
  rather than guessed at.

Artwork flow for Steam titles:

```
renderer  getArtwork(appId) -> game:resolve-artwork {appId} (zod: numeric, <= 32-bit)
   -> ArtworkResolver
      1. validate the App ID; invalid ids never become a URL or file name
      2. stat Steam's library cache for {appId}_library_600x900.jpg, _hero, _header, _logo
         -> file:// URLs (offline)
      3. HEAD each missing asset on cdn.akamai.steamstatic.com (4 s timeout)
         -> official CDN URLs for the ones that exist
      4. no local and no CDN asset -> placeholder:true, null URLs, built-in plate
      5. memoise positive results for 6 h and outages for 60 s, dedupe in-flight requests
```

`TUNESMITH_STEAM_CACHE_DIR` overrides the default Steam cache directory. The renderer never
supplies a URL or a path; it receives only URLs built by main, and the grid caches the result per
game for the session. A per-title placeholder or outage never throws across the bridge.

The legacy keyed SteamGridDB batch channel (`game:artwork`) remains for compatibility. Its API key
lives in main (environment or `userData/steamgriddb.key`), images are downloaded to
`userData/artwork-cache` and served as `ts-art://` URLs, and a missing key is a single
`not-configured` batch rather than per-card failures.

## 16. Performance OSD

A separate, transparent, frameless, non-focusable and click-through `BrowserWindow`, not a
DLL injection or swapchain hook. It is anchored to the foreground game's `GetWindowRect`
rectangle after DPI conversion and clamped to that display. It appears only while the active
session pid owns the foreground and hides on alt-tab; toggling and status go through the
narrow `game.osd`/`game:osd-set` channels.

FPS and 1% lows come from a PowerShell/C# ETW child subscribed to `Microsoft-Windows-DXGI`
PresentStart (42) and `Microsoft-Windows-D3D9` Present (1). The child filters by game pid,
keeps a 10-second frame window and emits strict JSON that is revalidated in TypeScript.
Failure to start ETW is displayed as `NO ETW`; the profile and temperature fields continue
to update. The overlay bridge can only subscribe to state — it has no invoke surface.

Live status: the ETW sampler was verified against a presenting Chromium GPU process
(144 FPS, 128.6 1% low, 6.9 ms). The window has not yet been exercised over a real game, so
exclusive-fullscreen and anti-cheat compatibility remain supervised checks. See
`docs/GAME-ENGINE.md` §12.

## 17. Auto-update

Packaged builds start `UpdaterService` after the main window is created. The service configures
`electron-log` with a 5 MiB `updater.log` under `userData/logs`, then schedules an initial check
after five seconds and a repeat every six hours. Development builds never schedule a check:
`app.isPackaged` gates both `start()` and the renderer-facing `check()` method.

`electron-builder` writes `resources/app-update.yml` with the GitHub owner/repository from the
package publish block. `electron-updater` downloads a newer release automatically; status flows
to the renderer through `tunesmith:update-status` and pushed updates through
`tunesmith:update-status-changed`. The footer shows checking/downloading/ready state. The
renderer's only mutation is `updater.install()`, which the main handler maps to the required
`tunesmith:install-update` channel and calls `quitAndInstall(false, true)` only when the phase is
`downloaded`. No URL, path or installer argument crosses the bridge.

Release automation lives in `.github/workflows/release.yml`: a `v*.*.*` tag must match
`package.json`, then the workflow runs `npm ci`, `npm run build` and
`npx electron-builder --win --publish always` with `GH_TOKEN`, then publishes the tag release
with `gh` as a retry-safe final step. The generated NSIS installer and `latest.yml` are attached
to a published (non-draft) GitHub release. Builds are unsigned unless a Windows signing
certificate is supplied. Full operational notes: `docs/UPDATER.md`.
