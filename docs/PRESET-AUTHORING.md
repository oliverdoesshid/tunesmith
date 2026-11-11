# Authoring a preset

A preset is a JSON document, validated against `schemas/preset.v1.schema.json` (editor support)
and `src/shared/preset/schema.ts` (authoritative). It describes *what* to change, never *how*
to change it.

## 1. Minimal working preset

```jsonc
{
  "$schema": "../../schemas/preset.v1.schema.json",
  "schemaVersion": 1,
  "signatureVersion": 1,
  "id": "my-ssd-latency-pack",          // lowercase kebab-case, 3-64 chars
  "name": "SSD Latency Pack",
  "version": "1.0.0",
  "description": "Tightens a few latency-sensitive defaults on NVMe systems.",
  "authors": [{ "handle": "your-handle" }],
  "license": "MIT",
  "risk": "moderate",
  "tags": ["gaming", "latency"],
  "requires": {
    "os": { "minBuild": 19041 },
    "elevation": true,
    "restorePoint": "preferred"          // required | preferred | none
  },
  "compatibility": {
    "storage": ["SSD"],
    "ramGb": { "min": 16 }
  },
  "profiles": [
    {
      "id": "base",
      "name": "Baseline",
      "actions": {
        "registry": [
          {
            "op": "set",
            "hive": "HKCU",
            "path": "System\\GameConfigStore",   // relative to the hive
            "name": "GameDVR_Enabled",
            "type": "REG_DWORD",
            "data": 0
          }
        ],
        "services": [{ "name": "DiagTrack", "startup": "Manual" }],
        "power": {
          "plan": "high-performance",
          "settings": [{ "setting": "usb-selective-suspend", "value": 0 }]
        }
      }
    }
  ]
}
```

## 2. The hardware signature

```
<cpu token>_<gpu token>_<ram token>_<drive token>

Intel_i7-14700K_RTX4070Ti_32GB_SSD
AMD_Ryzen5_5600X_RTX3060_32GB_SSD
Intel_Ultra7-155H_IntelArcA770_16GB_SSD
```

Find yours with `npm run detect`, or read it from the chip in the app header.

| Segment | Format | Examples |
|---|---|---|
| CPU | `Vendor_Model` (`Model` may contain `_`) | `Intel_i7-14700K`, `AMD_Ryzen9_7950X3D`, `AMD_ThreadripperPRO_5995WX` |
| GPU | model only, no vendor | `RTX4070Ti`, `RX7900XTX`, `UHD770`, `NOGPU` |
| RAM | nearest standard tier | `8GB`, `16GB`, `32GB`, `64GB` |
| Drive | system disk media type | `SSD`, `HDD`, `UNKNOWN` |

Matching is case-insensitive and supports a single `*` wildcard per token. `*` is the only
metacharacter — everything else is literal.

## 3. Compatibility

```jsonc
"compatibility": {
  "signature": ["Intel_i7-14*_RTX4*_32GB_*"],  // full-signature globs
  "cpu": ["Intel_i7-14700K", "Intel_i7-14700KF"],
  "gpu": ["RTX4*"],
  "ramGb": { "min": 16, "max": 64 },
  "storage": ["SSD"]
}
```

An omitted dimension is a wildcard. A specified dimension that does not match makes the preset
inapplicable — it is not a scoring preference. Match score is shown in the UI as
`matched / specified`.

`ramGb` is compared against the **bucketed tier**, the same number that appears in the
signature. A 32 GB machine reports 31.9 GB to the OS, so write `{ "min": 32 }` for a 32 GB
machine — not `{ "min": 30 }`. The same rule applies to `when.ramGb` on a profile.

## 4. Conditional profiles

```jsonc
"profiles": [
  { "id": "base", "name": "Always", "actions": { /* … */ } },
  {
    "id": "high-vram",
    "name": "High VRAM",
    "extends": "base",
    "when": { "gpuVramGb": { "min": 12 }, "cpuThreads": { "min": 12 } },
    "actions": { "priorities": [{ "process": "game.exe", "priority": "High" }] }
  }
]
```

Rules:

- A profile is active when its `when` matches **and** its `extends` parent is active.
- `extends` must reference a profile declared **earlier** in the array (no forward references,
  no cycles). Enforced by policy.
- Later active profiles override earlier ones **by target**. A variant only needs to restate
  the value it changes.
- `when` supports `cpu`, `gpu`, `ramGb`, `storage`, `gpuVramGb`, `cpuThreads`.

## 5. Action reference

### `registry`

```jsonc
{ "op": "set",    "hive": "HKCU", "path": "Control Panel\\Mouse", "name": "MouseSpeed", "type": "REG_SZ", "data": "0" }
{ "op": "delete", "hive": "HKCU", "path": "Control Panel\\Mouse", "name": "MouseSpeed" }
```

- `hive`: `HKCU` or `HKLM` only.
- `path`: relative to the hive, no `..`, no empty segments, no leading/trailing `\`, max 220
  chars, charset `[A-Za-z0-9_\\{}()., -]`.
- `type`: `REG_SZ`, `REG_EXPAND_SZ`, `REG_DWORD`, `REG_QWORD`. `data` must agree with it.
- `delete` must not include `type`/`data`.

### `services`

```jsonc
{ "name": "DiagTrack", "startup": "Disabled", "stop": true }
{ "name": "SysMain",   "startup": "Automatic", "delayedStart": true }
```

- `startup`: `Automatic` | `Manual` | `Disabled`.
- `delayedStart` requires `startup: "Automatic"`.
- `stop` stops the service now; rollback restarts it if it was running.
- At most **8** services may be `Disabled` per profile.
- Protected services are hard-blocked regardless of risk tier (Defender, firewall, RPC, EventLog,
  audio, Windows Update, SCM/WMI, …). See `PROTECTED_SERVICES` in `policy.ts`.
- Before apply, the plan dialog reads `DependOnService` / `DependOnGroup` and shows the
  target's requirements, its transitive dependents, and any protected service in that cascade.
  The tree is bounded and read-only; it never expands a group into guessed services and does
  not replace the policy block or apply-time capture.

### `priorities`

```jsonc
{ "process": "game.exe", "priority": "High" }
```

- Bare image name, `.exe` required, paths rejected, spaces allowed.
- `Idle | BelowNormal | Normal | AboveNormal | High`. `RealTime` does not exist in the vocabulary.
- **Volatile**: priority is not persisted; it reverts when the process restarts. The UI labels it.
- Protected processes (System, csrss, winlogon, lsass, services, svchost, dwm, Defender, …) are
  hard-blocked.

### `power`

```jsonc
"power": {
  "plan": "high-performance",
  "settings": [
    { "setting": "processor-min-state", "value": 100 },
    { "setting": "usb-selective-suspend", "value": 0 },
    { "setting": "pcie-link-state", "value": 0 }
  ]
}
```

Plans: `balanced`, `high-performance`, `power-saver`. Only the **AC** index is written; battery
behaviour is never changed.

| Setting id | Range | Meaning |
|---|---|---|
| `processor-min-state` | 0-100 | percent |
| `processor-max-state` | 0-100 | percent |
| `core-parking-min-cores` | 0-100 | percent of cores kept unparked |
| `core-parking-max-cores` | 0-100 | percent cap on unparked cores; pair with min 100 to keep every core available |
| `energy-performance-preference` | 0-100 | EPP, displayed with its hex value; 0 = performance, 100 = energy savings |
| `usb-selective-suspend` | 0-1 | 0 = disabled |
| `pcie-link-state` | 0-2 | 0 = off |
| `disk-idle-timeout` | 0-86400 | seconds, 0 = never |

EPP is a firmware/HWP frequency-energy hint, **not thread placement**. Use affinity for
P/E-core placement. Core parking is likewise system-wide. On Windows 11, EPP and
core-parking maximum are hidden from `powercfg -query`; the engine captures their effective
AC values through `PowerReadACValue` and still writes through `powercfg`. If that API cannot
read the value, the step is refused rather than mutated blindly. No BCD or registry unhide is
performed.

The value restored is the effective AC value. If the active scheme had no explicit override
for a hidden setting, rollback writes that same value as an explicit override instead of
deleting the hidden power-scheme key. Behaviour is preserved, but the registry shape is not
byte-identical to its pre-apply shape; this exception applies only to hidden power settings.

### `deviceInterrupts`, `irqPriorities`, `network` (aggressive only)

```jsonc
"deviceInterrupts": [{ "deviceClass": "gpu" }, { "deviceClass": "network", "messageLimit": 8 }]
"irqPriorities":    [{ "irq": 8, "priority": "high" }]
"network":           [{ "tcpAckFrequency": 1, "tcpNoDelay": 1 }]
```

- These are **data, not code**: the engine enumerates PCI devices (`Get-PnpDevice`,
  physical `PCI*` instances only) and active TCP interfaces at runtime. A preset names a
  class (`gpu` | `network`) or an IRQ number (0-255), never a registry key.
- `messageLimit` must be a power of two up to 32 — the only values MSI hardware negotiates.
- IRQ priority affects **every device sharing that line**, and is usually vestigial on
  MSI-X systems; prefer `deviceInterrupts` and leave this one out unless you measured it.
- `network` applies to every interface with a real DHCP lease or static address;
  disconnected interfaces are skipped.
- All three require `risk: "aggressive"` and warn unless `restorePoint: "required"`.

## 6. Risk tiers

| Tier | What it permits | Gated by |
|---|---|---|
| `conservative` | registry + power; may *enable* services, may not stop/disable them; may opt out of a restore point | nothing |
| `moderate` | also disables services, changes priorities | consent for restricted/unlisted keys |
| `aggressive` | same vocabulary plus interrupt/latency actions, larger blast radius | explicit risk checkbox in addition to consent |

`restorePoint: "none"` is only legal for `conservative` presets. A moderate or aggressive preset
that waives the checkpoint is rejected outright.

## 7. Registry policy tiers

- **Blocked** — never writable: `SAM`, `SECURITY`, `BCD00000000`, `Winlogon`, `Image File
  Execution Options`, `Session Manager`, `Services`, `Class`, `SafeBoot`, `Lsa`,
  `SecurityProviders`, `CI`, `DeviceGuard`, `WMI`, `Policies`, `Run*` (all hives and WOW6432Node
  mirrors), `Classes`, `Windows Defender`, `Ole`, `Rpc`, `Fonts`, shell-folder redirection.
- **Restricted** — needs consent: `GraphicsDrivers`, `Terminal Server`, `CrashControl`,
  `FileSystem`, `Network`, `Power`, `PriorityControl`, `MMCSS SystemProfile`.
- **Allowed** — the curated tuning surface: GameDVR, GameBar, mouse/keyboard, visual effects,
  DWM, MMCSS, `PowerThrottling`, `Explorer\VisualEffects`, etc.
- **Unlisted** — needs consent. If you need a new curated path, add it to `ALLOWED_REGISTRY`
  with a reason rather than asking users to click through consent.

## 8. What presets cannot do (by design)

- **BCD/HPET edits.** There is no boot-configuration action and there will not be one:
  a wrong BCD value bricks the boot and no journal can undo it. The safe path is the
  `power` vocabulary on the active scheme (100% processor states, no core parking,
  PCIe link-state off) — it achieves the Ultimate Performance attributes without touching
  the boot store.
- **Windows Defender tampering.** The `Windows Defender` keys and the Defender/Update
  services are hard-blocked (`service.protected`). Definition updates and scheduled scans
  stay on; a tuning preset is the wrong place to disable them, and Tamper Protection
  would fight the engine anyway. Re-enable toggles are unnecessary because nothing is
  ever disabled.
- **Cortana / policy-store writes.** `SOFTWARE\Policies` (both hives) and the legacy
  policy keys are blocked, and there is no HKCU Cortana toggle on current Windows
  (Cortana is removed; Start-menu search behaviour stays untouched).
- **Game DVR recording** *is* covered — `GameDVR_Enabled` / GameBar keys are on the
  curated surface — while the Xbox services themselves stay stoppable only through the
  normal `services` action with its caution warnings.

## 9. Adding a power setting

Hidden settings cannot be captured, and the engine refuses to write anything it cannot first
read. So:

1. On a real machine: `powercfg -query SCHEME_CURRENT <subgroup>` and confirm the setting is
   listed with a `Current AC Power Setting Index`. If it is hidden, verify that
   `PowerReadACValue` returns a `REG_DWORD` value (the existing EPP/core-parking max entries
   are examples), and mark it `readVia: 'power-api'`; do not unhide it.
2. Add the id to `POWER_SETTING_IDS` and the metadata to `POWER_SETTINGS` in
   `src/shared/power.ts`, with the subgroup, GUID, range and a human note.
3. Run the tests — the schema, policy ranges and UI labels all derive from that table.

Do not add "Ultimate Performance": it has no stable GUID (Windows duplicates it per machine).

## 10. Submit checklist

- [ ] `npm test` passes (schema, policy, and the shipped-library check).
- [ ] `npm run presets:hash` regenerated `index.json`.
- [ ] `risk` reflects the worst thing the preset disables, not the average.
- [ ] No registry path outside the curated surface without a stated reason.
- [ ] `description` says what will noticeably change for the user.
- [ ] Every `when` clause has a variant that is actually different from the base.
- [ ] You have applied it on hardware matching your `compatibility` block and used
      "Restore to default" afterwards.
