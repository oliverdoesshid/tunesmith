# Security model

> Scope: the preset supply chain, the privileged surface, and the rollback guarantee.

## 1. Trust boundaries

```
 UNTRUSTED   community preset JSON  ──┐
                                      │  integrity (sha256) → structural → semantic
 TRUSTED     TuneSmith source ────────┤
                                      │
 SEMI        renderer (sandboxed)  ────┤  narrow contextBridge API, sender check, zod
                                      │
 TRUSTED     main process  ────────────┤  fixed syscalls, argv arrays, no shell
                                      │
 PRIVILEGED  Windows APIs  ────────────┘  ADMIN
```

The renderer is treated as hostile even though we wrote it: it renders community-authored
text. The preload exposes named methods only — never a generic `invoke(channel, ...)` — so a
compromised renderer inherits the exact capability list in `TuneSmithApi`, not the IPC surface.

Outbound requests are limited to explicit paths: Steam artwork probes and image loads against
`cdn.akamai.steamstatic.com` (numeric App ID only), the optional SteamGridDB batch lookup, a
refresh of the configured signed marketplace catalog, and opt-in telemetry. They are issued by
main or by `<img>` from an allowlisted host; credentials and keys never cross the bridge. Steam
artwork returns `file://` cache hits or official CDN URLs, and the legacy SteamGridDB path returns
only `ts-art://` URLs served from the local cache.

The launcher CSP permits `file:` images so local cache hits render. Main only ever returns four
names generated from a validated App ID, but CSP cannot scope `file:` to one directory; a
compromised renderer could at most probe local image existence, not read pixels or files.

## 2. Assets

| Asset | Impact if lost |
|---|---|
| Boot integrity | machine unbootable |
| Logon/credential plumbing (`Winlogon`, `Lsa`, `SAM`, `SECURITY`) | total compromise or lockout |
| Code-integrity controls (Defender, DeviceGuard, CI) | silent malware persistence |
| Service dependency graph | unrelated features fail at boot |
| User's ability to undo | the central promise of the product |
| Audit trail (journal) | no recovery path after a bad session |
| SteamGridDB API key | quota abuse / credential disclosure |
| Game install paths | opening or starting an attacker-chosen file |
| Shader-cache files and their `app_id` executable paths | deleting valid pipelines; exposing installed app paths |
| GitHub release feed and update payload | remote code execution if a release or token is compromised |
| Game window geometry / OSD display data | overlaying the wrong window; leaking process details |

## 3. Threats and controls

| # | Threat | Controls | Residual risk |
|---|---|---|---|
| T1 | Preset executes arbitrary code / shell | closed vocabulary; no command action; argv arrays; `shell: false`; PowerShell bodies are static with escaped, regex-validated literals | low |
| T2 | Preset writes a persistence key (`Run`, `Winlogon`, `IFEO`, `AppInit`) | prefix **and** pattern denylist (`\CurrentVersion\Run*` catches HKCU, HKLM and WOW6432Node mirrors); blocked regardless of risk tier | low |
| T3 | Preset disables Defender/firewall/update/audio | protected-service map with per-service reasons; hard block | low |
| T4 | Preset causes a boot loop | `Session Manager`, `Services`, `Class`, `SafeBoot`, `CI`, `DeviceGuard` blocked; driver config out of scope; restore point + journal | medium (boot-time keys outside the vocabulary are not reachable, but a legitimate-looking tweak can still degrade stability) |
| T5 | Malicious preset smuggled into the library | index with SHA-256 per file; unlisted files rejected; bundled and marketplace signatures verified against pinned keys; duplicate ids rejected | medium — see §4, the default catalog is signed by the pinned publisher key |
| T6 | Renderer XSS → privilege escalation | `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, navigation/window/webview denial, permission denial, sender check, zod re-validation | low |
| T7 | Two sessions interleave | `mkdir` lock with holder record and stale takeover | low |
| T8 | Crash mid-apply leaves the machine half-tuned | durable-before-mutate, append-only journal, conservative recovery rollback | low |
| T9 | Unrestorable change (unknown prior value) | capture refuses unsupported value types; power settings that report no current value are never written | low |
| T10 | Elevation confusion (partially elevated session) | one explicit relaunch, whole app elevated; preflight blocks apply when not elevated | low |
| T11 | Preset floods the system with actions | hard budgets: 120 actions/profile, 8 disabled services/profile, 12 profiles | low |
| T12 | Secrets leak through logs/journal | journal stores only registry/service/power state; the SteamGridDB key is read in main, never logged, and never sent over IPC | low |
| T17 | Interrupt/latency action misconfigures MSI-X or IRQ priority and silences a device | aggressive-only gate; per-device/per-interface capture (absent included); Enum/IRQ writes fail closed and roll back; message limits restricted to negotiable powers of two | medium (a wrong-but-valid value needs a reboot, which is why the restore-point warning exists) |
| T18 | Requirement-8 scope creep: BCD/HPET, Defender, Cortana | no such action exists in the vocabulary, so there is nothing to gate — documented refusals in `PRESET-AUTHORING.md` §8 | none (unexpressible) |
| T13 | Game profile or Cryo-Freeze suspends the shell or a security process, freezing the desktop | `SUSPEND_DENYLIST` (shell, compositor, audio, logon, LSA, service host, Defender) blocks at policy level, not by warning; conservative profiles may not suspend at all; Cryo-Freeze uses a fixed candidate list that is re-filtered through the same deny/caution maps | low |
| T14 | Game profile points a per-app GPU preference at an arbitrary file | the value name is the *running* process path, validated as an absolute drive path; profiles never supply a path | low |
| T15 | Suspended processes survive an app crash | session file written before the suspend call (including automatic Cryo-Freeze pids), recovered at startup, and quit is deferred until restore completes | low |
| T16 | A malicious game profile or library manifest enumerates/selects processes | the watcher receives names derived from validated profiles and the read-only library scan and reports pids only; profile rules are policy-checked, and Cryo-Freeze can only choose its fixed allowlist, never an arbitrary pid or image from the renderer | low |
| T17 | A tampered launcher manifest points discovery at arbitrary files | discovery is read-only and bounded; install roots and launch paths are resolved and contained, only bare `.exe` names are retained, and nothing found is executed | low |
| T18 | A forged health baseline hides an OS update or allows journal deletion | the baseline lives under userData and is only written by the main process; cleanup requires a matching manifest/directory, a finalised clean status, zero pending rollback and age, and is user-initiated | low |
| T19 | A forged SteamGridDB response turns main into an SSRF client or injects a non-image | HTTPS + SteamGridDB host allowlist; API redirects refused, image final URL re-checked; 8 MiB cap; magic-byte image sniffing; content-addressed cache names; `ts-art://` accepts only `<sha>.<png|jpg|webp>` | low |
| T20 | Renderer asks to open or launch an arbitrary path | folders must match a scanner-discovered install root or a native-picker token; launches take a game id and use a detected `.exe` inside that root; manual entries require native-picker tokens, so the renderer never submits a path; `..`/UNC/device/ADS paths rejected; sender + zod + 24-item bound | low |
| T21 | OSD window is used as a second privileged renderer or an input surface | separate sandboxed renderer; preload exposes only `onState`; no invoke/inbound channel; non-focusable, click-through, navigation/window/webview denial | low |
| T22 | OSD “frame monitor” becomes an injection/hooking vector | no DLL, no hook, no game-memory access; read-only ETW present events from a static child body, filtered by the already-validated active pid; malformed lines rejected | low (ETW is an observation surface, not a write path) |
| T23 | Dependency preview is used to read or mutate arbitrary services | sender check + zod; only a preset id crosses the bridge; main compiles the plan and reads the fixed SCM subtree with a static script; rows are bounded and normalised; read-only, no executor path | low |
| T24 | Staged per-device interrupt affinity targets the wrong device/group or leaves a GPU, NVMe controller or NIC without interrupts after reboot | fixed runtime PnP classes (Display, `stornvme` SCSIAdapter, PCI Net), validated PCI instance ids, MSI-only devices, one-processor-group physical P-core mask, exact type/value/absence capture, parent-key existence check, restore and crash recovery, no device restart during play; the renderer supplies only a boolean and the write requires administrator rights | medium — a valid-but-wrong policy is applied only at the next device start; recovery requires a reboot or Safe Mode if the device fails to start |
| T25 | Renderer asks to delete an arbitrary file through the shader-cache panel | fixed LocalAppData roots; closed cache ids; IPC schema accepts only `directx` plus `confirm: true`; two-step UI; active game refusal; only whole `.dxcache` files with a valid `app_id` table whose every executable is missing and which are older than 24 hours; re-stat and re-analysis before `unlink`; symlinks, directories and vendor caches refused | low — an orphan is disposable by construction, but losing a valid cache costs one recompilation pass |
| T26 | Renderer supplies an update URL/path, or an attacker tampers with the release feed | packaged-only service; provider comes from electron-builder's `app-update.yml`, never from a request; HTTPS GitHub provider; installer arguments are fixed (`quitAndInstall(false, true)`); install is accepted only after `update-downloaded`; no URL/path/token crosses the bridge; electron-updater verifies the artifact digest from `latest.yml` | medium until the installer is code-signed — a compromised GitHub release or maintenance token can still ship a malicious but digest-matching payload |

## 4. Provenance: integrity plus signatures

Bundled presets are loaded with both checks enabled. A file must appear in `index.json`, its
SHA-256 must match, and a detached Ed25519 signature over the exact bytes must verify against
the pinned `PRESET_SIGNING_PUBLIC_KEY`. The signature is checked before the structural parser
sees the file.

Marketplace entries add a second signed layer:

- the publisher signs the canonical catalog, and the client refuses an unknown `keyId`;
- each entry carries a detached Ed25519 signature over the SHA-256 of its canonical payload;
- the key ring comes from `TUNESMITH_MARKET_KEYS` or `market/config.json`; when neither is
  present it falls back to the pinned publisher key used for bundled presets;
- fetches are HTTPS-only (loopback HTTP for development), and main re-verifies the payload and
  entry before writing canonical bytes into the user preset directory.

A stock build therefore trusts the published Pages catalog through the same pinned key it
already uses for bundled presets. Editing both a bundled preset and its local digest cannot
forge the pinned signature; editing a marketplace entry cannot forge the publisher signature
without its private key. Pointing the app at a different catalog requires an explicit key
ring, which replaces the default. Key rotation remains release work, not a gap in the verifier.

## 5. Privilege model

- The app runs unelevated by default: browsing, previewing and reading the journal all work.
- `Restart as administrator` relaunches the whole process via `Start-Process -Verb RunAs`.
  The user sees one UAC prompt, and every subsequent call runs in one consistent context.
- Applying without elevation fails in preflight with an explicit message, not with an
  access-denied from the middle of a transaction.
- The SCM dependency inventory is read-only and needs no elevation for the keys Windows
  exposes. It is not a mutation path, and its result is advisory rather than an approval.
- Shader-cache inventory and pruning operate only on the current user's own LocalAppData
  files, so they need no elevation. The app never asks for administrator rights for this
  panel and never accepts a path from the renderer.
- The updater runs in the packaged main process. It reads only the generated GitHub provider
  configuration and downloads to electron-updater's private cache. The renderer cannot select
  a feed or installer; its install request is argument-free. The NSIS target is per-user and
  the app does not request elevation for an update.
- The OSD does not request elevation. Real-time ETW requires elevation or `Performance Log
  Users`; without it the overlay degrades to profile/temperature display and never silently
  claims a frame rate. The overlay window itself needs no privilege.

## 6. Why the audit tables are data

`policy.ts` is deliberately a set of tables (`BLOCKED_REGISTRY`, `RESTRICTED_REGISTRY`,
`PROTECTED_SERVICES`, `PROTECTED_PROCESSES`, budgets). A reviewer can diff a table without
reading any execution code, and the executor never consults the tables — it only dispatches
typed actions the compiler already approved. One place judges, another place acts.

## 7. What this app cannot do

By construction, not merely by policy:

- run a program, script or shell command *of its own choosing*. The launcher can start a
  scanner-detected `.exe` inside its install root after an explicit click, or an entry the user
  added through the native folder/executable picker; the renderer submits opaque picker tokens,
  never paths, so neither a preset nor a renderer-supplied path can name an executable;
- create, delete or reconfigure a service, or mutate one through the read-only dependency
  preview;
- write outside `HKCU`/`HKLM`, or into any denylisted subtree;
- set `RealTime` priority, or touch `System`/`smss`/`csrss`/`lsass`/`winlogon`/`dwm`/Defender;
- delete a file outside the fixed shader-cache roots. The only deletion path accepts the
  closed `directx` cache id and removes a whole `.dxcache` file only when its own metadata
  proves every recorded executable is gone; vendor caches are never deleted, and no renderer
  path is accepted;
- choose an update source, update URL, downloaded file or installer argument. The packaged
  updater uses the compiled GitHub provider; the renderer can read status and request install
  after a completed download, nothing more;
- write raw `powercfg` GUIDs, or write DC (battery) power values;
- modify boot configuration (BCD/HPET), drivers, scheduled tasks, Defender, or the network stack;
  per-interface TCP ack values, MSI-X enablement and documented per-device interrupt-affinity
  policy are registry state, not stack surgery; game network tuning follows the same rule: a
  profile names only typed TCP values and an optional moderation choice, never an adapter, GUID
  or registry path; the route is derived from the game's live endpoints and the snapshot is saved
  in the game session before writing. Interrupt affinity is a fixed, runtime-enumerated
  GPU/NVMe/NIC policy staged without restarting the device; the renderer supplies only a boolean;
- inject a DLL, hook a graphics API, read game memory or write to a game process. The OSD is a
  separate window; its frame data comes from read-only ETW present events.

The launcher is the one exception to "nothing executes", and it is deliberately narrow: the user
clicks Play on a library card. For a scanner title, main re-resolves the title from its own
read-only scan and checks the executable is a detected candidate inside that install root. For a
manual title, the add request contained only opaque tokens minted by the native folder/executable
picker; main resolved and validated those paths before persisting the entry. Main then arms the
watcher and calls `shell.openPath`. There is no argv, no shell, no URL protocol, no working
directory from the renderer, and no way for the renderer to name a path discovery or the native
picker did not provide.

Game mode can also suspend background processes. That is not an arbitrary capability: profile
rules are schema- and policy-checked against the deny/caution maps, while Cryo-Freeze can only
choose from its fixed, code-owned candidate list. The renderer supplies booleans, never pids or
image names. Every selected pid is written to the session before `NtSuspendProcess` is called and
is resumed by the same exit, recovery and quit paths.

Game mode can also stage per-device interrupt affinity. The renderer supplies only a boolean;
the device list comes from PnP, is reduced to physical PCI Display, NVMe (`stornvme`) and Net
devices, and is filtered to MSI-enabled hardware. The PCI instance id is validated before it is
used in a registry path, the mask is derived from the detected one-group topology, and every
prior registry type/value (including absence) is saved in the game session before the first
write. The engine never restarts a GPU, NVMe controller or NIC during play: Windows reads the
policy when the device next starts, and that limitation is shown in the UI. A failed write or
restore is recorded rather than hidden, and crash recovery uses the same snapshot.

## 8. Checklist for a new action type

1. Is the capability expressible without a shell string?
2. Can the prior state be captured *exactly* (including "absent")?
3. Can it be restored idempotently, including after a partial failure?
4. Does it need a policy tier, and what is the worst-case misconfiguration?
5. Is there a meaningful denylist (paths, names, values) that a reviewer can read?
6. Does it have a fake-adapter test covering failure *and* rollback?
7. Does it change the signature? If so, bump `SIGNATURE_VERSION`.

The post-apply watchdog is not a new mutation path. It is a read-only sampler that calls the
existing journaled rollback when a threshold trips. The stability probe has no write API;
the only privilege it can exercise is the rollback already granted to the user's apply.

EPP and core-parking maximum are hidden Windows processor settings. They remain in the
curated power vocabulary and are written only through `powercfg`; their effective AC values
are read through `PowerReadACValue` so capture fails closed when Windows cannot report them.
The application never unhides settings, edits BCD, or accepts a raw power GUID from a preset.
EPP is a frequency/energy hint, not a thread-placement control.
