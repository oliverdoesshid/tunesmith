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

The only outbound request is the optional SteamGridDB artwork lookup. It is issued by main, uses
a key that never crosses the bridge, and returns only `ts-art://` URLs served from the local
cache.

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
| Game window geometry / OSD display data | overlaying the wrong window; leaking process details |

## 3. Threats and controls

| # | Threat | Controls | Residual risk |
|---|---|---|---|
| T1 | Preset executes arbitrary code / shell | closed vocabulary; no command action; argv arrays; `shell: false`; PowerShell bodies are static with escaped, regex-validated literals | low |
| T2 | Preset writes a persistence key (`Run`, `Winlogon`, `IFEO`, `AppInit`) | prefix **and** pattern denylist (`\CurrentVersion\Run*` catches HKCU, HKLM and WOW6432Node mirrors); blocked regardless of risk tier | low |
| T3 | Preset disables Defender/firewall/update/audio | protected-service map with per-service reasons; hard block | low |
| T4 | Preset causes a boot loop | `Session Manager`, `Services`, `Class`, `SafeBoot`, `CI`, `DeviceGuard` blocked; driver config out of scope; restore point + journal | medium (boot-time keys outside the vocabulary are not reachable, but a legitimate-looking tweak can still degrade stability) |
| T5 | Malicious preset smuggled into the library | index with sha256 per file; unlisted file ⇒ integrity failure; duplicate ids rejected | **high** — see §4, the digest is not a signature |
| T6 | Renderer XSS → privilege escalation | `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, navigation/window/webview denial, permission denial, sender check, zod re-validation | low |
| T7 | Two sessions interleave | `mkdir` lock with holder record and stale takeover | low |
| T8 | Crash mid-apply leaves the machine half-tuned | durable-before-mutate, append-only journal, conservative recovery rollback | low |
| T9 | Unrestorable change (unknown prior value) | capture refuses unsupported value types; power settings that report no current value are never written | low |
| T10 | Elevation confusion (partially elevated session) | one explicit relaunch, whole app elevated; preflight blocks apply when not elevated | low |
| T11 | Preset floods the system with actions | hard budgets: 120 actions/profile, 8 disabled services/profile, 12 profiles | low |
| T12 | Secrets leak through logs/journal | journal stores only registry/service/power state; the SteamGridDB key is read in main, never logged, and never sent over IPC | low |
| T17 | Interrupt/latency action misconfigures MSI-X or IRQ priority and silences a device | aggressive-only gate; per-device/per-interface capture (absent included); Enum/IRQ writes fail closed and roll back; message limits restricted to negotiable powers of two | medium (a wrong-but-valid value needs a reboot, which is why the restore-point warning exists) |
| T18 | Requirement-8 scope creep: BCD/HPET, Defender, Cortana | no such action exists in the vocabulary, so there is nothing to gate — documented refusals in `PRESET-AUTHORING.md` §8 | none (unexpressible) |
| T13 | Game profile suspends the shell or a security process, freezing the desktop | `SUSPEND_DENYLIST` (shell, compositor, audio, logon, LSA, service host, Defender) blocks at policy level, not by warning; conservative profiles may not suspend at all | low |
| T14 | Game profile points a per-app GPU preference at an arbitrary file | the value name is the *running* process path, validated as an absolute drive path; profiles never supply a path | low |
| T15 | Suspended processes survive an app crash | session file written before the suspend call, recovered at startup, and quit is deferred until restore completes | low |
| T16 | A malicious game profile enumerates processes | the watcher receives a watch list derived from validated profiles and reports pids only; it has no policy authority | low |
| T17 | A tampered launcher manifest points discovery at arbitrary files | discovery is read-only and bounded; install roots and launch paths are resolved and contained, only bare `.exe` names are retained, and nothing found is executed | low |
| T18 | A forged health baseline hides an OS update or allows journal deletion | the baseline lives under userData and is only written by the main process; cleanup requires a matching manifest/directory, a finalised clean status, zero pending rollback and age, and is user-initiated | low |
| T19 | A forged SteamGridDB response turns main into an SSRF client or injects a non-image | HTTPS + SteamGridDB host allowlist; API redirects refused, image final URL re-checked; 8 MiB cap; magic-byte image sniffing; content-addressed cache names; `ts-art://` accepts only `<sha>.<png|jpg|webp>` | low |
| T20 | Renderer asks to open or launch an arbitrary path | folders must match a scanner-discovered install root; launches take a game id and use a detected `.exe` inside that root; `..`/UNC/device/ADS paths rejected; sender + zod + 24-item bound | low |
| T21 | OSD window is used as a second privileged renderer or an input surface | separate sandboxed renderer; preload exposes only `onState`; no invoke/inbound channel; non-focusable, click-through, navigation/window/webview denial | low |
| T22 | OSD “frame monitor” becomes an injection/hooking vector | no DLL, no hook, no game-memory access; read-only ETW present events from a static child body, filtered by the already-validated active pid; malformed lines rejected | low (ETW is an observation surface, not a write path) |
| T23 | Dependency preview is used to read or mutate arbitrary services | sender check + zod; only a preset id crosses the bridge; main compiles the plan and reads the fixed SCM subtree with a static script; rows are bounded and normalised; read-only, no executor path | low |

## 4. Provenance — the honest gap

The current build verifies **integrity**: each preset file's sha256 must match the reviewed
index, and a file absent from the index is rejected. That detects corruption and casual
tampering, and it makes "a preset appeared in the folder" impossible.

It does **not** prove authorship. Anyone who can rewrite both the file and `index.json` can
rewrite the digest. Production distribution needs:

1. **Ed25519 signature over the manifest** (`index.json` + digests), public key pinned in the
   app binary.
2. **Key rotation** with a signed rotation statement.
3. **HTTPS-only fetch** with certificate validation, and a local cache that re-verifies
   signatures on every load.

The loader already models trust as a value (`bundled-verified` | `unverified`) rather than a
boolean, so adding a signature check is a change to one stage, not to the pipeline.

## 5. Privilege model

- The app runs unelevated by default: browsing, previewing and reading the journal all work.
- `Restart as administrator` relaunches the whole process via `Start-Process -Verb RunAs`.
  The user sees one UAC prompt, and every subsequent call runs in one consistent context.
- Applying without elevation fails in preflight with an explicit message, not with an
  access-denied from the middle of a transaction.
- The SCM dependency inventory is read-only and needs no elevation for the keys Windows
  exposes. It is not a mutation path, and its result is advisory rather than an approval.
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

- run a program, script or shell command *of its own choosing*. The launcher can start one of a
  title's scanner-detected `.exe` files inside its install root after an explicit click; neither
  a preset nor a renderer-supplied path can name an executable;
- create, delete or reconfigure a service, or mutate one through the read-only dependency
  preview;
- write outside `HKCU`/`HKLM`, or into any denylisted subtree;
- set `RealTime` priority, or touch `System`/`smss`/`csrss`/`lsass`/`winlogon`/`dwm`/Defender;
- write raw `powercfg` GUIDs, or write DC (battery) power values;
- modify boot configuration (BCD/HPET), drivers, scheduled tasks, Defender, or the network stack;
  per-interface TCP ack values and MSI-X enablement are registry state, not stack surgery;
  game network tuning follows the same rule: a profile names only typed TCP values and an
  optional moderation choice, never an adapter, GUID or registry path; the route is derived
  from the game's live endpoints and the snapshot is saved in the game session before writing;
- inject a DLL, hook a graphics API, read game memory or write to a game process. The OSD is a
  separate window; its frame data comes from read-only ETW present events.

The launcher is the one exception to "nothing executes", and it is deliberately narrow: the user
clicks Play on a library card, main re-resolves the title from its own read-only scan, checks the
executable is a detected candidate inside that install root, arms the watcher, and calls
`shell.openPath`. There is no argv, no shell, no URL protocol, no working directory from the
renderer, and no way to launch a path discovery did not find.

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
