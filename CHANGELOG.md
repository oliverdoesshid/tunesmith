# Changelog

All notable changes to TuneSmith are recorded here. Releases follow the tags published on
[GitHub Releases](https://github.com/oliverdoesshid/tunesmith/releases).

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
