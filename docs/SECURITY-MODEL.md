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

## 2. Assets

| Asset | Impact if lost |
|---|---|
| Boot integrity | machine unbootable |
| Logon/credential plumbing (`Winlogon`, `Lsa`, `SAM`, `SECURITY`) | total compromise or lockout |
| Code-integrity controls (Defender, DeviceGuard, CI) | silent malware persistence |
| Service dependency graph | unrelated features fail at boot |
| User's ability to undo | the central promise of the product |
| Audit trail (journal) | no recovery path after a bad session |

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
| T12 | Secrets leak through logs/journal | journal stores only registry/service/power state; no env, no tokens, no user paths beyond registry keys | low |
| T17 | Interrupt/latency action misconfigures MSI-X or IRQ priority and silences a device | aggressive-only gate; per-device/per-interface capture (absent included); Enum/IRQ writes fail closed and roll back; message limits restricted to negotiable powers of two | medium (a wrong-but-valid value needs a reboot, which is why the restore-point warning exists) |
| T18 | Requirement-8 scope creep: BCD/HPET, Defender, Cortana | no such action exists in the vocabulary, so there is nothing to gate — documented refusals in `PRESET-AUTHORING.md` §8 | none (unexpressible) |
| T13 | Game profile suspends the shell or a security process, freezing the desktop | `SUSPEND_DENYLIST` (shell, compositor, audio, logon, LSA, service host, Defender) blocks at policy level, not by warning; conservative profiles may not suspend at all | low |
| T14 | Game profile points a per-app GPU preference at an arbitrary file | the value name is the *running* process path, validated as an absolute drive path; profiles never supply a path | low |
| T15 | Suspended processes survive an app crash | session file written before the suspend call, recovered at startup, and quit is deferred until restore completes | low |
| T16 | A malicious game profile enumerates processes | the watcher receives a watch list derived from validated profiles and reports pids only; it has no policy authority | low |

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

## 6. Why the audit tables are data

`policy.ts` is deliberately a set of tables (`BLOCKED_REGISTRY`, `RESTRICTED_REGISTRY`,
`PROTECTED_SERVICES`, `PROTECTED_PROCESSES`, budgets). A reviewer can diff a table without
reading any execution code, and the executor never consults the tables — it only dispatches
typed actions the compiler already approved. One place judges, another place acts.

## 7. What this app cannot do

By construction, not merely by policy:

- run a program, script, or shell command;
- create, delete or reconfigure a service;
- write outside `HKCU`/`HKLM`, or into any denylisted subtree;
- set `RealTime` priority, or touch `System`/`smss`/`csrss`/`lsass`/`winlogon`/`dwm`/Defender;
- write raw `powercfg` GUIDs, or write DC (battery) power values;
- modify boot configuration (BCD/HPET), drivers, scheduled tasks, Defender, or the network stack;
  per-interface TCP ack values and MSI-X enablement are registry state, not stack surgery.

## 8. Checklist for a new action type

1. Is the capability expressible without a shell string?
2. Can the prior state be captured *exactly* (including "absent")?
3. Can it be restored idempotently, including after a partial failure?
4. Does it need a policy tier, and what is the worst-case misconfiguration?
5. Is there a meaningful denylist (paths, names, values) that a reviewer can read?
6. Does it have a fake-adapter test covering failure *and* rollback?
7. Does it change the signature? If so, bump `SIGNATURE_VERSION`.
