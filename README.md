# TuneSmith

Windows performance tuning from community presets, matched to your exact hardware signature,
with a rollback guarantee that survives a crash — plus per-game profiles that apply while a
specific game has focus and undo themselves when it exits. Installed Steam, Epic, Xbox and GOG
titles are discovered from their local manifests and matched to bundled profiles automatically;
titles from anywhere else can be added manually in the launcher. A Steam-like launcher resolves
covers from the local Steam cache or Valve's public CDN with no API key, adds validated local-file
browsing, and quick launch that arms the game watcher before the game starts. While a game
session is active, opt-in Cryo-Freeze can pause a fixed allowlist of cloud-sync, updater and
telemetry processes with `NtSuspendProcess`, then resume them when the game exits or recovery
runs. An optional performance OSD draws the active profile, frame rate, 1% lows and temperatures
in a separate transparent window; it never injects into the game. For competitive titles, game-route network tuning follows the interface carrying the live server connection and restores it on exit. An opt-in IRQ affinity layer stages the documented per-device MSI/MSI-X policies for the GPU, NVMe controller and physical NIC on physical performance cores, journals every prior registry value and restores it when the session ends; Windows applies the policy at the device's next start, so the engine never restarts those devices mid-game. Packaged builds check GitHub Releases through `electron-updater`, show download progress in the footer and install only after the renderer explicitly requests it. After an aggressive preset applies, a five-minute watchdog rolls it back automatically on a thermal, DPC-pressure or freeze-sized stall trip.
A passive health watchdog watches for Windows updates and core system-file drift that could
invalidate a journal, and offers a reviewed recovery path. A read-only shader-cache health panel
inventories DirectX PSO caches plus NVIDIA and AMD driver caches; orphan cleanup removes a whole
DirectX `.dxcache` file only when the file's own SQLite metadata proves every recorded executable
is gone and the file has been idle for 24 hours. Hashed vendor caches remain monitor-only.

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
<CPU>_<GPU>_<RAM>_<STORAGE>
```

That string is a machine-generated signature, not a preset ID: every PC gets its own from the
detected components. It is the contract between that machine and a preset, and
`docs/ARCHITECTURE.md` explains why it is versioned.

## Status

**v0.2.1 release preview.** The safety-critical core, signed preset marketplace, game profiles
and desktop workbench are implemented and tested. This build is intended for supervised testing
on Windows 10/11 rather than unattended consumer deployment: the installer is unsigned, the
auto-update feed and installer handoff still need a supervised release pass, there is no settings
screen, and a stock build ships without a marketplace curator key. System mutations are
journaled and reversible, but live apply/rollback and game sessions should be tested on a
disposable account or VM first.

### What's new in v0.2.1

- Fixed the blank packaged window caused by production tree-shaking removing React scheduler
  side effects. The built renderer now mounts the workbench in both Chromium and Electron.
- The preset marketplace is published at
  [oliverdoesshid.github.io/tunesmith/market](https://oliverdoesshid.github.io/tunesmith/market/).

### v0.2.0 highlights

- Packaged builds now check GitHub Releases through `electron-updater`, show download progress
  in the footer, and install only after an explicit request. Version tags drive the NSIS release
  workflow and `latest.yml` upload.
- A read-only shader-cache health panel inventories DirectX PSO caches and NVIDIA/AMD driver
  caches. Confirmed orphaned DirectX `.dxcache` files can be pruned; vendor caches remain
  monitor-only.
- Opt-in IRQ affinity stages per-device MSI/MSI-X policy for the GPU, NVMe controller and NIC on
  physical performance cores, and restores the captured registry values when the session ends.
- The launcher accepts manual game entries, resolves local artwork without an API key, and adds
  in-place game settings. Cryo-Freeze can pause a fixed allowlist of background processes for
  the duration of a session and resumes them on exit or recovery.

## Requirements

- Windows 10 2004 (build 19041) or newer
- Node.js 20.11+
- Administrator rights to **apply** presets (browsing works unelevated)
- Elevation or membership in `Performance Log Users` for OSD frame rates. Without it, the OSD still shows the active profile and available temperatures, and labels FPS as unavailable.

## Install (Windows)

Download the latest `TuneSmith-Setup-<version>.exe` from the
[GitHub releases page](https://github.com/oliverdoesshid/tunesmith/releases/latest) and run it.
The installer is not code-signed, so Windows SmartScreen may show an "Unknown publisher"
warning. Verify the SHA-512 recorded in the release's `latest.yml` before running it.

TuneSmith can browse and preview unelevated. Applying system changes needs administrator
rights; the app offers a single UAC relaunch rather than requiring the whole session to start
elevated.

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

### Steam artwork (no API key)

Steam covers need no account, key or subscription. For each Steam App ID the main process checks
Steam's local library cache (`C:\Program Files (x86)\Steam\appcache\librarycache`) for
`{appId}_library_600x900.jpg`, `{appId}_hero.jpg`, `{appId}_header.jpg` and `{appId}_logo.png`,
returning `file://` URLs so the launcher works offline. Missing cache entries fall back to Valve's
public CDN (`cdn.akamai.steamstatic.com`) after a short HEAD probe; if neither has the image, the
grid keeps its generated plate. Set `TUNESMITH_STEAM_CACHE_DIR` to use a Steam installation in a
non-default location. The older keyed SteamGridDB batch channel remains available for
compatibility but is not used by the grid.

### Static preset market

The public marketplace is
[oliverdoesshid.github.io/tunesmith/market](https://oliverdoesshid.github.io/tunesmith/market/).
`market/` is a standalone, dependency-free Steam-dark storefront for GitHub Pages.
`npm run market:index` rebuilds `market/index.json` from `presets/community/`, validates every
preset against the schema, verifies its SHA-256 and pinned Ed25519 `.sig`, and emits raw GitHub
download URLs. The publish workflow typechecks, regenerates the catalog, fails when the committed
index is stale, and deploys the folder under `/market/`. The static index is a discovery and
one-click install surface; the in-app signed `catalog.json` channel remains separate.

### Release tags and auto-update

Pushing a tag matching `v*.*.*` runs `.github/workflows/release.yml`. The workflow verifies that
the tag matches `package.json`, builds the application, then runs
`npx electron-builder --win --publish always` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to
publish a non-draft GitHub release, upload `TuneSmith-Setup-<version>.exe` and attach `latest.yml`,
then explicitly publish the tag release (recovering a draft left by an interrupted run). The
workflow needs `contents: write`; the build is unsigned unless a Windows signing certificate is
configured. Packaged builds read the GitHub provider from the generated `app-update.yml`; see
`docs/UPDATER.md` for the runtime flow and limitations. Release history: [`CHANGELOG.md`](CHANGELOG.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | esbuild watch (main + both preloads) + Vite + Electron, relaunching on main changes |
| `npm run dev:ui` | Renderer only, mock bridge (browser) |
| `npm run build` | Production bundles: `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/preload/overlay.cjs`, `dist/cli/index.cjs`, `dist/renderer/**` |
| `npm run cli -- <cmd>` | Headless CLI: `presets`, `apply --preset <id> [--dry-run]`, `sessions`, `rollback`, `restore`. See `docs/CLI.md` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | 427 unit tests (signature, schema, policy, matcher, compiler, loader, executor, detection, game engine, game network, Cryo-Freeze, IRQ-affinity planning and staging, shader-cache inventory and orphan pruning, auto-update lifecycle, post-apply watchdog, EPP/core parking, service dependencies, library discovery, manual launcher entries, launcher/Steam artwork, static market index, performance OSD, health watchdog, elevation handoff) |
| `npm run detect` | Run real hardware detection in a terminal, outside Electron |
| `node scripts/topology.mjs` | Print the CPU topology that affinity planning uses |
| `npm run presets:hash` | Regenerate `presets/community/index.json` digests |
| `npm run market:index` | Rebuild `market/index.json`; validates presets, SHA-256 and Ed25519 signatures |
| `npm run market:check` | Fail if `market/index.json` is stale |
| `npm run build:win` | Package the built app with electron-builder into `dist/TuneSmith-Setup-<version>.exe` |
| `npm run package` | `npm run build` + `npm run build:win` (unsigned NSIS installer) |

## Diagnostics

TuneSmith writes a persistent, rotating log for the main process, renderer messages, IPC
timings, process failures, window lifecycle, security decisions and the administrator
relaunch handoff. Packaged builds use `%APPDATA%\TuneSmith\logs\tunesmith.log`; development
builds use the same path under the development user-data directory. The file rolls at 5 MB
and keeps three archives (`tunesmith.1.log` through `tunesmith.3.log`).

## Layout

```
CHANGELOG.md            release history and per-version change lists
presets/community/      shipped presets + index.json (sha256 per file)
presets/games/          per-game runtime profiles
market/                 GitHub Pages storefront + generated static catalog
schemas/                JSON Schema mirror for editor tooling
scripts/                build/dev helpers, preset signing, market index generation
src/shared/             pure domain: signature, preset schema, policy, matcher, compiler, loader
src/shared/service-graph.ts  bounded, read-only SCM dependency graph builder
src/shared/shader-cache.ts   closed cache ids, health DTOs and prune contracts
src/shared/updater.ts        display-only update status DTO
src/shared/game/        game types, schema, policy, affinity maths, IRQ mask planning, trigger matching
src/main/platform/      one adapter per system tool (reg.exe, sc.exe, powercfg.exe, PowerShell)
                        + interrupts.ts (MSI-X / IRQ priority / per-interface TCP)
                        + interrupt-affinity.ts (per-device GPU/NVMe/NIC affinity capture/apply/restore)
                        + service-registry.ts (read-only SCM dependency inventory)
src/main/platform/game/ watcher, control, CPU topology, read-only game library discovery,
                        manual game store
src/main/health/        build/servicing/file probes, baseline persistence, watchdog, stale-journal cleanup
src/main/engine/        preflight, compiler output → executor, journal, lock
src/main/engine/game/   game profile loading, session persistence, activate/restore state machine
src/main/overlay/       performance OSD window lifecycle, placement and display DTO
src/main/services/      Steam cache/CDN artwork, SteamGridDB cache, ts-art protocol, game paths,
                        shader-cache fixed-root scan and metadata-proven orphan pruning
src/main/updater.ts     packaged GitHub Releases check/download/install service + rotated log
src/main/security/      CSP, navigation guards, permission denial
src/main/logging.ts    persistent rotated main/renderer/IPC/elevation log
src/preload/            contextBridge: named methods only; the overlay preload exposes onState only
src/cli/                headless companion CLI (same loader, compiler, journal, executor)
src/renderer/           React UI + display-only overlay.html (no privileged capability; GameLauncherGrid renders Steam cache/CDN covers)
.github/workflows/      Pages market publish + tag-driven NSIS release (`release.yml`)
tests/                  unit + integration tests
docs/                   ARCHITECTURE · SECURITY-MODEL · PRESET-AUTHORING · GAME-ENGINE · SHADER-CACHE · UPDATER · HEALTH-WATCHDOG · MARKETPLACE · CLI
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
15. **IRQ affinity is staged, never hot-restarted.** The opt-in layer enumerates physical
    GPU/NVMe/NIC devices itself and writes the documented `DevicePolicy` and
    `AssignmentSetOverride` values; the renderer supplies only a boolean. Every prior value,
    including absence, is captured in the game session before the write. Windows reads this
    policy when a device starts, so the engine deliberately does not restart a GPU, NVMe
    controller or NIC during play; the change takes effect after the device next starts.
16. **Aggressive presets get a stability window.** Five minutes of thermal and DPC sampling
    follows a successful aggressive apply. Above 90 °C, sustained DPC pressure, or a
    15-second process stall calls the normal journal rollback immediately. Missing sensors
    are reported as unavailable, never as safe. This is an additional tripwire, not a claim
    that any preset is universally stable.
17. **Processor power hints are audited, not raw hex.** Presets name only curated power ids;
    the engine resolves their GUIDs. EPP and core-parking maximum are hidden by
    `powercfg` but are captured through `PowerReadACValue`, then set through `powercfg`.
    Unreadable settings are refused rather than written blind. EPP is a frequency-energy
    hint, not a thread-placement mechanism.
18. **Service dependency maps are read-only and advisory.** The plan preview reads only
    `HKLM\\SYSTEM\\CurrentControlSet\\Services`, validates every row, and caps the tree so a
    malformed registry cannot hang the UI. It never writes a service key, and it does not
    replace the protected-service policy or apply-time capture. Group dependencies are shown
    as group nodes, not guessed into individual services.
19. **Auto-update is packaged-only and renderer-constrained.** The renderer receives
    status only, never a feed URL, installer path or installer argument. A package that
    is not built with `app.isPackaged` never checks or installs. Installation is accepted
    only after `update-downloaded`, and `quitAndInstall()` runs without renderer-supplied
    parameters. `electron-updater` reads the GitHub provider from the generated
    `app-update.yml`; the renderer can see progress but cannot choose a release.
20. **Shader-cache cleanup is metadata-proven, not a wildcard delete.** Only fixed
    LocalAppData cache roots are read, and only a whole DirectX `.dxcache` file whose SQLite
    `app_id` table lists no surviving executable (and which has been untouched for 24 hours)
    can be removed. A file with any live or unknown app reference is preserved; NVIDIA and AMD
    hashed caches are never deleted; symlinks and directories are refused; the UI asks twice
    and the IPC request must carry `confirm: true`; pruning is refused during an active game.

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
- **Steam artwork is fixture-tested, not live-tested.** Local cache naming, CDN URLs/probes,
  negative caching and the placeholder path are unit-tested; the suite does not exercise a real
  Steam library or live CDN round-trip. The browser preview uses generated art, and the grid still
  needs a visual pass on a real installation.
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
- **IRQ affinity is staged, not live.** Windows reads per-device `DevicePolicy` and
  `AssignmentSetOverride` when the device's resources are assigned. TuneSmith writes and
  journals them during a session and restores the prior values on exit or recovery, but it
  does not restart a GPU, NVMe controller or NIC mid-game; the policy takes effect after that
  device next starts, and the restored values are likewise read at its next start. The write
  requires administrator rights. Machines spanning multiple processor groups and devices
  without MSI/MSI-X are refused or skipped rather than guessed at.
- **EPP and core-parking maximum are hidden Windows settings.** They are captured through
  the read-only `PowerReadACValue` API and written through `powercfg`; nothing is unhidden and
  BCD is never touched. If the active scheme had no explicit override, restore leaves an
  explicit override at the same effective value rather than deleting the hidden power key.
  Firmware may ignore EPP, and EPP is a frequency/energy hint, not thread placement.
- **Shader-cache cleanup is DirectX-only and was not pruned live.** The read-only scan was run
  against a real Windows cache (and recognised stale DirectX databases), but no live cache file
  was deleted during development; deletion is covered by SQLite fixtures with re-stat, age,
  live-app and opaque-vendor cases. NVIDIA and AMD caches are hashed driver blobs with no game
  mapping, so they are inventoried but never cleaned. The DirectX `app_id` schema is an internal
  driver detail: missing, large or malformed metadata is preserved rather than guessed at, and a
  file containing one live app is kept in full. Deleting an orphan removes only its own entries;
  the first launch of the affected title can recompile pipelines and hitch once. No before/after
  frame-time measurement is claimed.
- **Auto-update has not been exercised against a published release.** Packaged builds read the
  GitHub provider from electron-builder's `app-update.yml`, download with `electron-updater`, and
  expose a footer install action. Development builds never contact the feed. The installer and
  update payload are currently unsigned; production should add Windows code signing before
  relying on publisher-name verification, and the first release should be a supervised
  check → download → restart cycle. `latest.yml` and the NSIS asset are generated locally; the
  GitHub tag workflow is included but was not run from this workstation.
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
- **Preset provenance has two layers.** Bundled presets are covered by `index.json` SHA-256
  digests and detached Ed25519 signatures verified against the pinned key. Marketplace catalogs
  and entries carry their own Ed25519 signatures and are refused without a configured key ring.
  A stock build has no curator key, so the marketplace stays closed. See
  `docs/SECURITY-MODEL.md` §4.
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
- **Outbound traffic is limited to explicit paths.** The default Steam artwork resolver probes and
  loads images from `cdn.akamai.steamstatic.com` using only a numeric App ID; the optional
  SteamGridDB batch lookup, refresh of the configured signed marketplace catalog, telemetry only
  after the user opts in, and the packaged GitHub Releases update check/download are the others.
  Preset application itself never fetches data.

## Verification

The repository is checked with:

- `npm run typecheck` — clean.
- `npm test` — 427/427 passing across 44 files.
- `npm run build` — main, preload, overlay-preload and CLI bundles emitted, both HTML entry
  points present, artifact sizes asserted.
- `npm run detect -- --json` — real detection on a supported Windows host: generates that
  machine's CPU/GPU/RAM/storage signature, with VRAM read from the display driver key rather than
  WMI's clamped value, and virtual display adapters excluded from the signature.
- `node scripts/topology.mjs` — live CPU-set query; validates logical/physical core mapping and
  SMT pairs.
- ETW present sampling — live against a presenting Chromium GPU process; validates FPS, 1% low and
  frame-time samples. The target was a browser process, not a game.

Not verified by the test suite: live apply/rollback against the OS, a real game session, an OSD
window over a real game, a cumulative-update transition, a live SteamGridDB lookup, a live
GitHub update feed, or a quick launch against a real game (see limitations). The read-only health
probe can check the local Windows build, servicing state and core file hashes without mutating
anything.

## Next steps

A curator-signed default marketplace catalog and key-rotation plan, a settings screen,
Windows code signing for the installer and update payload, dry-run reads of current values in
the preview, and an ETW-based before/after measurement so a preset's claim can be checked
rather than trusted.
