# TuneSmith

Windows performance tuning from community presets, matched to your exact hardware signature,
with a rollback guarantee that survives a crash — plus per-game profiles that apply while a
specific game has focus and undo themselves when it exits. Installed Steam, Epic, Xbox and GOG
titles are discovered from their local manifests and matched to bundled profiles automatically. A Steam-like launcher adds cached SteamGridDB artwork, validated local-file browsing, and quick launch that arms the game watcher before the game starts. An optional performance OSD draws the active profile, frame rate, 1% lows and temperatures in a separate transparent window; it never injects into the game. For competitive titles, game-route network tuning follows the interface carrying the live server connection and restores it on exit. After an aggressive preset applies, a five-minute watchdog rolls it back automatically on a thermal, DPC-pressure or freeze-sized stall trip.
A passive health watchdog watches for Windows updates and core system-file drift that could
invalidate a journal, and offers a reviewed recovery path.

The power vocabulary also exposes modern processor controls: EPP (the Windows/HWP
Energy Performance Preference), core-parking minimum and maximum, and the existing
processor states. Hidden HWP values are captured through the read-only Windows power API and
written through `powercfg`; nothing touches BCD.

Before a preset with service changes can be applied, the plan preview reads the Service
Control Manager registry and draws the affected dependency trees. It shows what a service
requires, which services require it, and any protected core services in the cascade. The map is
read-only and advisory; policy and apply-time capture remain the gates.

Electron + React + TypeScript. Built around three rules: a preset is **data, never code**;
nothing is mutated before it can be **undone**; and refusing is a valid outcome.

```
AMD_Ryzen5_5600X_RTX3060_32GB_SSD
```

That string is the contract between a machine and a preset. `docs/ARCHITECTURE.md` explains
why it is versioned.

## Status

Foundational skeleton — architecture and the safety-critical core are complete and tested.
It is not yet a shippable consumer product: preset distribution is not signed, there is no
auto-update, and the UI has no settings screen.

## Requirements

- Windows 10 2004 (build 19041) or newer
- Node.js 20.11+
- Administrator rights to **apply** presets (browsing works unelevated)
- Elevation or membership in `Performance Log Users` for OSD frame rates. Without it, the OSD still shows the active profile and available temperatures, and labels FPS as unavailable.

## Quick start

```bash
npm install

# npm 11 may gate postinstall scripts; if the Electron binary is missing:
node node_modules/electron/install.js

npm run dev        # Electron window with HMR
npm run dev:ui     # renderer only, in a browser, with an in-memory mock
```

`npm run dev:ui` is not a toy: it compiles the **real** shipped presets through the **real**
compiler against a fixture machine, and only simulates the system calls. It is the fastest way
to review UI work without elevation.

### SteamGridDB artwork

The launcher works without a key: each card falls back to generated lettering. To enable artwork,
create a key at <https://www.steamgriddb.com/profile/preferences/api> and either export
`STEAMGRIDDB_API_KEY` or save the key as one line in `steamgriddb.key` in TuneSmith's user-data
folder (`%APPDATA%\TuneSmith` for packaged builds). The key is read only by the main process.
Images are cached under `%APPDATA%\TuneSmith\artwork-cache` and served to the renderer through the
private `ts-art://` scheme; remote image URLs never cross the context bridge.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | esbuild watch (main + both preloads) + Vite + Electron, relaunching on main changes |
| `npm run dev:ui` | Renderer only, mock bridge (browser) |
| `npm run build` | Production bundles: `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/preload/overlay.cjs`, `dist/cli/index.cjs`, `dist/renderer/**` |
| `npm run cli -- <cmd>` | Headless CLI: `presets`, `apply --preset <id> [--dry-run]`, `sessions`, `rollback`, `restore`. See `docs/CLI.md` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | 366 unit tests (signature, schema, policy, matcher, compiler, loader, executor, detection, game engine, game network, post-apply watchdog, EPP/core parking, service dependencies, library discovery, launcher/artwork, performance OSD, health watchdog, elevation handoff) |
| `npm run detect` | Run real hardware detection in a terminal, outside Electron |
| `node scripts/topology.mjs` | Print the CPU topology that affinity planning uses |
| `npm run presets:hash` | Regenerate `presets/community/index.json` digests |
| `npm run build:win` | Package the built app with electron-builder into a `dist/` NSIS installer |
| `npm run package` | `npm run build` + `npm run build:win` (unsigned NSIS installer) |

## Diagnostics

TuneSmith writes a persistent, rotating log for the main process, renderer messages, IPC
timings, process failures, window lifecycle, security decisions and the administrator
relaunch handoff. Packaged builds use `%APPDATA%\TuneSmith\logs\tunesmith.log`; development
builds use the same path under the development user-data directory. The file rolls at 5 MB
and keeps three archives (`tunesmith.1.log` through `tunesmith.3.log`).

## Layout

```
presets/community/      shipped presets + index.json (sha256 per file)
presets/games/          per-game runtime profiles
schemas/                JSON Schema mirror for editor tooling
src/shared/             pure domain: signature, preset schema, policy, matcher, compiler, loader
src/shared/service-graph.ts  bounded, read-only SCM dependency graph builder
src/shared/game/        game types, schema, policy, affinity maths, trigger matching
src/main/platform/      one adapter per system tool (reg.exe, sc.exe, powercfg.exe, PowerShell)
                        + interrupts.ts (MSI-X / IRQ priority / per-interface TCP)
                        + service-registry.ts (read-only SCM dependency inventory)
src/main/platform/game/ watcher, control, CPU topology, read-only game library discovery
src/main/health/        build/servicing/file probes, baseline persistence, watchdog, stale-journal cleanup
src/main/engine/        preflight, compiler output → executor, journal, lock
src/main/engine/game/   game profile loading, session persistence, activate/restore state machine
src/main/overlay/       performance OSD window lifecycle, placement and display DTO
src/main/services/      SteamGridDB fetch/cache, ts-art protocol, validated game folder/launch paths
src/main/security/      CSP, navigation guards, permission denial
src/main/logging.ts    persistent rotated main/renderer/IPC/elevation log
src/preload/            contextBridge: named methods only; the overlay preload exposes onState only
src/cli/                headless companion CLI (same loader, compiler, journal, executor)
src/renderer/           React UI + display-only overlay.html (no privileged capability; GameLauncherGrid renders cached ts-art)
tests/                  unit + integration tests
docs/                   ARCHITECTURE · SECURITY-MODEL · PRESET-AUTHORING · GAME-ENGINE · HEALTH-WATCHDOG · CLI
```

## Safety guarantees

1. **Closed vocabulary.** Nine action shapes only (registry, services, priorities, power,
   plus aggressive-only MSI-X/IRQ-priority/per-interface-TCP actions that name device
   classes, never keys). No preset can name an executable, a shell
   command, a raw hive, or a raw power GUID. Every system call uses an argv array with
   `shell: false`.
2. **Durable before mutate.** Each step's exact prior state is written and `fsync`ed to an
   append-only journal *before* the mutation. If the write fails, nothing changes.
3. **Fail closed.** A value that cannot be read — or is a type we cannot restore, such as
   `REG_BINARY` — is never modified.
4. **Automatic rollback.** A failure at any step rolls back everything already applied,
   including the failed step (it may have partially applied).
5. **Crash recovery.** A session interrupted mid-apply is surfaced on next launch and can be
   restored conservatively.
6. **Restore point first.** A checkpoint is attempted before any change; `required` presets
   abort if it cannot be created, `preferred` ones continue with journal-only protection and
   say so.
7. **One writer.** A cross-process lock prevents concurrent sessions.
8. **Game mode restores itself.** A game session writes every pid it suspends and every
   value it changes to disk *before* acting, restores on exit, recovers after a crash, and
   defers application quit until the restore completes. The shell, compositor, audio engine,
   logon and Defender are never suspended.
9. **Thermal guards release, then wait.** A game profile may set CPU/GPU temperature limits
   and an AC-only rule. A trip restores every change, and the profile is not re-applied until
   a cool-down elapses. Sensors are read-only and reported honestly when unavailable.
10. **Profiles adapt to the machine.** Logical processors, RAM tier and GPU kind narrow a
    game profile at activation: small CPUs use all cores, suspension counts are capped, the
    timer hold is skipped on low-tier systems, and a high-performance GPU preference is
    dropped without a discrete GPU. Adaptation is deterministic and runs no model or
    background service, so nothing competes with the game for resources.
11. **Health drift is observed, not auto-repaired.** A read-only watchdog compares
    Windows build/servicing state and four core system-image hashes with a persisted
    baseline. It only notifies; re-applying a pinned preset still goes through the normal
    plan review, signature, consent and risk gates. Journal cleanup removes only finished,
    old journals with zero pending rollback entries.

12. **Launcher actions use discovered paths only.** "Browse local files" opens a folder only
    when it is exactly a scanner-discovered install root; quick launch starts only a detected
    `.exe` inside that root. Relative, traversing, UNC/device and arbitrary paths are refused,
    and no preset or renderer string can choose an executable. SteamGridDB downloads are
    HTTPS-only, host-allowlisted, size-capped and image-sniffed in the main process.
13. **The OSD observes, never injects.** The performance overlay is a separate transparent,
    focusless, click-through BrowserWindow. It never loads a DLL, hooks the game, or writes to
    its process; FPS and 1% lows come from read-only ETW present events, and the window is only
    shown while the active game owns the foreground. If ETW is unavailable it says so instead
    of fabricating frame data. This removes an injection vector; it is not a guarantee that
    every anti-cheat or exclusive-fullscreen title will display the window.
14. **Game network tuning follows the live route, not a preset path.** Interface GUIDs,
    adapter names and server endpoints are derived at activation from Windows enumeration;
    the profile supplies only typed TCP/NIC values. Only interfaces with an established TCP
    flow are changed, the prior values are durably recorded in the game session, and restore
    runs on exit or crash recovery. A conservative game profile cannot enable it.
15. **Aggressive presets get a stability window.** Five minutes of thermal and DPC sampling
    follows a successful aggressive apply. Above 90 °C, sustained DPC pressure, or a
    15-second process stall calls the normal journal rollback immediately. Missing sensors
    are reported as unavailable, never as safe. This is an additional tripwire, not a claim
    that any preset is universally stable.
16. **Processor power hints are audited, not raw hex.** Presets name only curated power ids;
    the engine resolves their GUIDs. EPP and core-parking maximum are hidden by
    `powercfg` but are captured through `PowerReadACValue`, then set through `powercfg`.
    Unreadable settings are refused rather than written blind. EPP is a frequency-energy
    hint, not a thread-placement mechanism.
17. **Service dependency maps are read-only and advisory.** The plan preview reads only
    `HKLM\\SYSTEM\\CurrentControlSet\\Services`, validates every row, and caps the tree so a
    malformed registry cannot hang the UI. It never writes a service key, and it does not
    replace the protected-service policy or apply-time capture. Group dependencies are shown
    as group nodes, not guessed into individual services.

The registry policy also hard-blocks persistence and boot keys (`Run*` including WOW6432Node,
`Winlogon`, `IFEO`, `Session Manager`, `Services`, `Class`, `CI`, `DeviceGuard`) and protected
services (Defender, firewall, update, audio, RPC, Event Log, SCM/WMI).

## Known limitations

- **Game mode has not been run against a real game.** Detection, policy, activation, restore
  and crash recovery are unit-tested; the first real session is still a supervised test. See
  `docs/GAME-ENGINE.md` §9.
- **Quick launch has not been run against a real game.** It arms the watcher, then starts the
  best detected `.exe` with `shell.openPath`. Steam/Epic DRM, launcher stubs and Microsoft Store
  titles may need their own client; MSIX titles are refused with an explanation. Treat the first
  quick launch as a supervised test.
- **The performance OSD has not been shown over a real game.** Its placement, state mapping,
  ETW parsing and IPC wiring are unit-tested; the ETW sampler was verified live against a
  presenting Chromium process, and the overlay page was rendered in the browser preview. The
  Electron window itself still needs a supervised pass with a game, especially exclusive
  fullscreen and anti-cheat titles. It uses normal always-on-top presentation, not a graphics
  hook, so a game that bypasses or covers desktop windows may hide it; borderless-windowed mode
  is the reliable presentation mode. "100% anti-cheat safety" is not a claim anyone can make
  for a third-party process, but TuneSmith never injects code or reads game memory.
- **OSD frame timing needs ETW permission.** Starting a real-time ETW session requires
  elevation or `Performance Log Users`. The app deliberately does not request elevation for
  this; when the session cannot start, temperatures and profile details still render and the
  FPS fields show `NO ETW` with the reason. Hardware temperatures still depend on the sensor
  sources listed below.
- **SteamGridDB artwork is fixture-tested, not live-tested.** Search/parse/cache, host
  allowlisting, magic-byte checks, negative caching and the missing-key path are unit-tested; no
  live API key or real game library was available during development. The browser preview uses
  generated art, and the grid still needs a visual pass on a real installation.
- **Thermal guards depend on what the machine exposes.** With LibreHardwareMonitor or
  OpenHardwareMonitor running, TuneSmith reads package temperatures, any-vendor GPU
  temperatures and real power draw from it. Without one, CPU temperature falls back to ACPI
  thermal zones (absent on many desktops) and GPU temperature to `nvidia-smi` (NVIDIA only).
  When a sensor is missing the session records that the guard could not be enforced instead
  of pretending it was.
- **Game network tuning and the post-apply watchdog are not live-verified against a game or
  a trip.** Route discovery, capture ordering and restore are unit-tested with a fake adapter;
  the watchdog's thermal/DPC/freeze paths are unit-tested, but the real PowerShell route write,
  NIC property write and a genuine thermal trip have not been run on this development host.
  TCP values are per-interface and therefore also affect other TCP traffic on that NIC while
  active; UDP-only games have no TCP stack value to tune. The freeze detector observes the
  app's event-loop stall, and it can only act after the process runs again. Closing TuneSmith
  ends the monitoring window; the applied session remains available for manual rollback.
- **EPP and core-parking maximum are hidden Windows settings.** They are captured through
  the read-only `PowerReadACValue` API and written through `powercfg`; nothing is unhidden and
  BCD is never touched. If the active scheme had no explicit override, restore leaves an
  explicit override at the same effective value rather than deleting the hidden power key.
  Firmware may ignore EPP, and EPP is a frequency/energy hint, not thread placement.
- **The service dependency map is declarative, not a runtime dependency analysis.** It reads
  `DependOnService` / `DependOnGroup`, follows the nearest six levels and caps the tree at 160
  nodes; service groups are not expanded. The map is advisory, so a missing or stale registry
  declaration does not replace policy or apply-time capture.
- **The marketplace ships without a pinned catalog key.** The client defaults to the
  project's GitHub Pages catalog and can be pointed elsewhere with `TUNESMITH_MARKET_URL`
  or `market/config.json`. No curator key is bundled, so a stock build reports a
  verification/configuration error instead of listing unverified entries. Verification,
  install (SHA-256 plus Ed25519) and the telemetry queue are implemented and tested.
- **Efficiency Mode needs Windows 11 and is untested live.** The `eco-mode` switch-on and
  switch-off paths are unit-tested, but no real game session has toggled them yet.
- **Requirement-8 mutations are unit-tested, not run live.** MSI-X enablement, IRQ priority,
  per-interface TCP values and the 0.5 ms timer hold are covered by 24 tests (including
  capture/rollback contracts), but no device Enum key or TCP interface has been written
  during development — only read-only probes (`Get-PnpDevice`, `reg query`) verified the
  key shapes. BCD/HPET edits and Defender tampering are refused by design, not by policy.
  See `docs/PRESET-AUTHORING.md` §8.
- **Game detection polls every 2 s** rather than hooking process creation, so a game is
  matched up to one interval after it takes focus. This is deliberate: injection into a game
  process is anti-cheat territory and buys nothing here.
- **Multi-group affinity is implemented but only unit-tested.** Plans are split into
  per-group masks and applied with `SetThreadGroupAffinity`, so 128- and 256-thread
  machines no longer refuse outright; the first session on such a machine is still a
  supervised test.
- **The standby-memory purge is shipped off** in every bundled profile; it needs elevation
  and usually makes load times worse.
- **Preset provenance is integrity-checked, not signed.** sha256 against `index.json` detects
  corruption and casual tampering; it does not prove authorship. See `docs/SECURITY-MODEL.md` §4.
- **Process priority is volatile.** It applies until the target process restarts; the UI labels
  it as non-persistent.
- **The mutation paths have not been executed against a live host during development.** Only
  read-only probes were used (hardware detection, `reg query`, `sc qc`, `powercfg -query`), plus
  a probe of `sc config`'s argument shape against a non-existent service. Applying a preset is
  the first real mutation, and it is designed to be undoable.
- **Power vocabulary is deliberately small** — six settings, all with GUIDs verified by
  `powercfg -query` on a real machine. `Ultimate Performance` is excluded (no stable GUID).
- **`REG_BINARY` / `REG_MULTI_SZ` are excluded**, as are drivers, BCD, scheduled tasks and
  service creation.
- **The health watchdog is a targeted tripwire, not a full file-integrity scanner.** It
  hashes four core system images and tracks build/servicing state; it does not scan
  `System32` or run SFC. A probe warning is surfaced rather than treated as healthy.
- **Recovery is reviewed, not silent.** The pinned-preset action opens the normal plan
  preview and consent flow; an aggressive or restricted preset still needs the same
  acknowledgements, and an active game session must be stopped first.
- **The only outbound request is the optional SteamGridDB artwork lookup.** Preset application
  never fetches data; the marketplace and its opt-in telemetry are separate and documented.
  There is no auto-update.

## Verification

Run in this workspace:

- `npm run typecheck` — clean.
- `npm test` — 366/366 passing across 34 files.
- `npm run build` — main, preload, overlay-preload and CLI bundles emitted, both HTML entry
  points present, artifact sizes asserted.
- `npm run detect -- --json` — real detection on the host: `AMD_Ryzen5_5600X_RTX3060_32GB_SSD`,
  with VRAM read from the display driver key (`0x300000000` = 12 GiB) rather than WMI's clamped
  4 GiB, and virtual display adapters excluded from the signature.
- `node scripts/topology.mjs` — live CPU-set query: 12 logical processors, 6 physical cores,
  SMT pairs correctly identified.
- ETW present sampling — live against a presenting Chromium GPU process: 144.0 FPS, 128.6 FPS
  1% low, 6.9 ms frame time. The target was a browser process, not a game.

Not verified here: live apply/rollback against the OS, a real game session, an OSD window over a real game, and a real
cumulative-update transition, a live SteamGridDB lookup, or a quick launch against a real game (see limitations). The health probe itself was run read-only on
the host: build `26300.9711`, all four file hashes, servicing state, 98 ms, no warnings.

## Next steps

Signed preset distribution (Ed25519 over the manifest), a settings screen, dry-run reads of
current values in the preview, and an ETW-based before/after measurement so a preset's claim can
be checked rather than trusted.
