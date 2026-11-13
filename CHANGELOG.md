# Changelog

All notable changes to TuneSmith are recorded here. Releases follow the tags published on
[GitHub Releases](https://github.com/oliverdoesshid/tunesmith/releases).

## [0.3.0] - 2026-11-13

### Added

- A Settings dialog that enables or disables every workspace feature independently and stores
  the choice on this machine. Game watcher, Cryo-Freeze, IRQ pinning and performance OSD are
  also switchable from Settings, with unsafe changes disabled during an active game session.
- Added signed **Scheduler & Input Latency** and **Entry Gaming — Cool & Responsive** presets.
  The first targets MMCSS game priority, foreground quantum, capture overhead and low-latency
  power hints; the second targets 8–16 GB machines without pinning every core at 100%.
  Both regenerate the signed community and marketplace indexes.
- Game profiles can now switch to a named Windows power plan for the session and restore the
  exact previous plan on exit, thermal release, game-mode shutdown, and crash recovery. Added
  bundled **Fortnite — Performance** and **Apex Legends — Performance** profiles that use it.
- Added a single-use worker/VM sandbox for community extension scripts. Scripts receive only a
  frozen, allowlisted snapshot of six registry observations and five service states, with a
  500 ms CPU deadline, a 64 MB worker heap and Zod-validated messages on both ends. Extensions
  are read-only advisors; they cannot write system state or reach Node globals.
- Added a zero-allocation `Float32Array` telemetry ring buffer, a Canvas 2D renderer that draws
  on `requestAnimationFrame`, and a React 19 wrapper with DPI-aware resizing and hover
  scrubbing. The performance OSD now carries a live frame-time history graph.
- Added local-only crash diagnostics: Crashpad minidumps are written under the app's userData
  folder with upload disabled, unexpected exits and an unclean-shutdown marker become incident
  records, and a reviewed report correlates the dump window with the durable journal and log
  tail. The Settings diagnostics drawer exports a ZIP with optional redaction; minidumps are
  excluded unless explicitly selected.
- Marketplace uploads can be submitted from the app: presets are schema/policy checked, scanned
  at VirusTotal, and only a clean result creates a reviewed GitHub pull request. Nothing goes
  live until a maintainer signs and merges it.

### Security

- Community extension execution is isolated from the Electron main thread. The VM context has
  a null-prototype global, string code generation disabled, no timers or Node module access,
  and no mutation API; worker termination is the backstop for runaway CPU or memory use.

### Performance

- Idle game detection now scans every 10 seconds instead of every 2 seconds. Foreground
  changes still trigger an immediate scan, so activation is unchanged while the armed watcher
  uses less CPU.
- The dashboard memory meter refreshes every 15 seconds while idle and every 5 seconds during
  an active game, and the desktop installer no longer carries the unused headless CLI bundle.

## [0.2.1] - 2026-11-13

### Fixed

- Fixed the blank packaged window. Vite's custom aggressive tree-shaking removed React scheduler
  side effects, so the built renderer attached a React root but never committed the workbench.
  The unsafe tree-shaking overrides were removed and the packaged renderer was verified in
  Electron.

### Added

- Published the preset marketplace on GitHub Pages at
  https://oliverdoesshid.github.io/tunesmith/market/.

## [0.2.0] - 2026-11-12

### Added

- GitHub Releases auto-update through `electron-updater`: packaged builds check after startup
  and every six hours, show download progress in the footer, and install only after an explicit
  request. The renderer receives display-only status and cannot choose a feed, file or installer
  argument.
- Tag-driven Windows release workflow for NSIS installers and `latest.yml`, including an explicit
  non-draft publication step for retries.
- Shader-cache health panel for DirectX PSO caches and NVIDIA/AMD driver caches. Only whole
  orphaned DirectX `.dxcache` files with valid metadata can be pruned; vendor caches are
  monitor-only.
- Opt-in per-device IRQ affinity staging for GPU, NVMe and NIC MSI/MSI-X policy on physical
  performance cores, with registry capture and session-end restore.
- Manual game entries in the launcher, local/Steam CDN artwork resolution without an API key,
  and in-place per-game settings.
- Cryo-Freeze controls for a fixed allowlist of background sync, updater and telemetry processes,
  with resume on session exit or recovery.
- Static marketplace index generation and the GitHub Pages storefront.
- Documentation for auto-update, shader-cache behavior, security boundaries and game tuning.

### Changed

- NSIS artifacts now use the deterministic `TuneSmith-Setup-<version>.exe` name so `latest.yml`
  references the actual uploaded asset.
- README and architecture documentation updated for the v0.2.0 feature set and release process.

### Security

- Update status is sanitized before crossing the renderer bridge; error URLs and installer paths
  remain in the local updater log.
- Installing an update is refused while a game session is active.

### Known limitations

- The installer and update payload are unsigned.
- Live apply/rollback, game sessions and the installed update handoff still require supervised
  Windows testing.

## [0.1.0] - 2026-11-11

### Added

- Signed community preset marketplace with Ed25519 signatures and SHA-256 verification.
- Preset compiler, journaled executor, rollback and preflight safety checks.
- Hardware-signature matching, the desktop workbench and game tuning diagnostics.
- Crash telemetry consent, thermal guards and release documentation.
