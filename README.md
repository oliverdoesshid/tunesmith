# TuneSmith

Windows performance tuning from community presets, matched to your exact hardware signature,
with a rollback guarantee that survives a crash — plus per-game profiles that apply while a
specific game has focus and undo themselves when it exits.

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

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | esbuild watch (main + preload) + Vite + Electron, relaunching on main changes |
| `npm run dev:ui` | Renderer only, mock bridge (browser) |
| `npm run build` | Production bundles: `dist/main/index.cjs`, `dist/preload/index.cjs`, `dist/cli/index.cjs`, `dist/renderer/**` |
| `npm run cli -- <cmd>` | Headless CLI: `presets`, `apply --preset <id> [--dry-run]`, `sessions`, `rollback`, `restore`. See `docs/CLI.md` |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | 136 unit tests (signature, schema, policy, matcher, compiler, loader, executor, detection, game engine) |
| `npm run detect` | Run real hardware detection in a terminal, outside Electron |
| `node scripts/topology.mjs` | Print the CPU topology that affinity planning uses |
| `npm run presets:hash` | Regenerate `presets/community/index.json` digests |
| `npm run package` | electron-builder NSIS installer (unsigned) |

## Layout

```
presets/community/      shipped presets + index.json (sha256 per file)
presets/games/          per-game runtime profiles
schemas/                JSON Schema mirror for editor tooling
src/shared/             pure domain: signature, preset schema, policy, matcher, compiler, loader
src/shared/game/        game types, schema, policy, affinity maths, trigger matching
src/main/platform/      one adapter per system tool (reg.exe, sc.exe, powercfg.exe, PowerShell)
                        + interrupts.ts (MSI-X / IRQ priority / per-interface TCP)
src/main/platform/game/ watcher, affinity/priority/suspend control, CPU topology
src/main/engine/        preflight, compiler output → executor, journal, lock
src/main/engine/game/   game profile loading, session persistence, activate/restore state machine
src/main/security/      CSP, navigation guards, permission denial
src/preload/            contextBridge: named methods only
src/cli/                headless companion CLI (same loader, compiler, journal, executor)
src/renderer/           React UI (no privileged capability)
tests/                  unit + integration tests
docs/                   ARCHITECTURE · SECURITY-MODEL · PRESET-AUTHORING · GAME-ENGINE · CLI
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

The registry policy also hard-blocks persistence and boot keys (`Run*` including WOW6432Node,
`Winlogon`, `IFEO`, `Session Manager`, `Services`, `Class`, `CI`, `DeviceGuard`) and protected
services (Defender, firewall, update, audio, RPC, Event Log, SCM/WMI).

## Known limitations

- **Game mode has not been run against a real game.** Detection, policy, activation, restore
  and crash recovery are unit-tested; the first real session is still a supervised test. See
  `docs/GAME-ENGINE.md` §9.
- **Thermal guards depend on what the machine exposes.** With LibreHardwareMonitor or
  OpenHardwareMonitor running, TuneSmith reads package temperatures, any-vendor GPU
  temperatures and real power draw from it. Without one, CPU temperature falls back to ACPI
  thermal zones (absent on many desktops) and GPU temperature to `nvidia-smi` (NVIDIA only).
  When a sensor is missing the session records that the guard could not be enforced instead
  of pretending it was.
- **The marketplace ships without a catalog or key.** Verification, install and the
  telemetry queue are implemented and tested, but a public endpoint and pinned Ed25519 key
  are operator-supplied (see `docs/MARKETPLACE.md`). No key is bundled, so a stock build
  shows a configuration hint instead of a catalog.
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
- **Single-file IPC only.** No network, no telemetry, no auto-update.

## Verification

Run in this workspace:

- `npm run typecheck` — clean.
- `npm test` — 136/136 passing across 13 files.
- `npm run build` — main 922 kB, preload 2.9 kB (after splitting channel names out of the zod
  module), renderer bundle emitted, artifact sizes asserted.
- `npm run detect -- --json` — real detection on the host: `AMD_Ryzen5_5600X_RTX3060_32GB_SSD`,
  with VRAM read from the display driver key (`0x300000000` = 12 GiB) rather than WMI's clamped
  4 GiB, and virtual display adapters excluded from the signature.
- `node scripts/topology.mjs` — live CPU-set query: 12 logical processors, 6 physical cores,
  SMT pairs correctly identified.

Not verified here: live apply/rollback against the OS, and a real game session (see
limitations).

## Next steps

Signed preset distribution (Ed25519 over the manifest), a settings screen, dry-run reads of
current values in the preview, and an ETW-based before/after measurement so a preset's claim can
be checked rather than trusted.
