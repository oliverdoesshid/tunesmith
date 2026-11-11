# Headless CLI

`tunesmith-cli` is a companion binary for scripting and maintenance. It is not a second
implementation: it links the **same** preset loader (sha256 integrity gate), the same
compiler, the same policy layer and the same journaling executor as the desktop app. The
CLI adds no capability — every option it accepts becomes one of the closed action shapes
already in the vocabulary.

```
dist/cli/index.cjs          entry point (built by `npm run build`)
package.json#bin            tunesmith-cli -> dist/cli/index.cjs
```

## Usage

```bash
npm run build                       # produces dist/cli/index.cjs
npm run cli -- presets              # what is installed and applicable here
npm run cli -- apply --preset competitive-fps-low-latency --dry-run
npm run cli -- apply --preset competitive-fps-low-latency --yes
npm run cli -- sessions
npm run cli -- rollback --session <id>
npm run cli -- restore
```

After `npm install -g .` (or any global install), the same commands are available as
`tunesmith-cli ...`.

### Preset sources

The CLI reads the same two directories as the desktop app, in the same order:

1. bundled `presets/community` — every listed file must carry a valid Ed25519 signature;
2. `%APPDATA%\TuneSmith\presets\community` — marketplace installs. These were verified
   against the signed catalog (payload SHA-256 plus entry signature) before being written,
   so they do not need a second per-file signature. `--user-data <dir>` moves this
   directory, which is useful for scripted tests and portable installs.

A bundled preset wins if both sources provide the same id, matching the GUI.

### Options

| Option | Meaning |
|---|---|
| `--preset <id>` | Preset to apply. Ids are kebab-case; a path is rejected by the parser |
| `--session <id>` | Session to roll back |
| `--dry-run` | Compile and print the plan. **Mutates nothing**, needs no elevation |
| `--yes` | Acknowledge consent-requiring changes (restricted/unlisted registry keys, service stops) |
| `--risk` | Acknowledge the blast radius of an `aggressive` preset |
| `--json` | One JSON document on stdout; progress goes nowhere else |
| `--user-data <dir>` | Absolute path to the shared session directory |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The transaction failed (the executor rolled back what it could) |
| `2` | Usage error |
| `3` | Administrator rights are required |
| `4` | Refused: policy block, inapplicable hardware, or a missing acknowledgement |

Distinct codes are deliberate: a script can tell "this preset is wrong for this machine"
(`4`) apart from "the change did not stick" (`1`) without parsing prose.

## Safety model

Unchanged from the desktop app, because it is the same code:

1. **Integrity first.** The library is read through `loadPresetDirectory`, so a file that is
   not in `index.json`, or whose digest does not match, never becomes a candidate.
2. **Durable before mutate.** The executor writes each step's captured prior state to the
   journal and `fsync`s it before the mutation, then records the outcome.
3. **Fail closed.** A value that cannot be captured is not modified. A blocked plan is
   refused before a session is opened.
4. **Restore point first.** `createRestorePoint` runs exactly as in the GUI; `required`
   presets abort if it fails.
5. **One writer.** The same `sessions/lock` (mkdir) mutex is used, so a CLI run and a GUI
   run cannot interleave — the second one fails with exit code `1` and a `locked` reason.
6. **Same journal, same undo.** Sessions live in `%APPDATA%\TuneSmith\sessions`, so a
   change applied by the CLI appears in the GUI's Sessions panel and vice versa.

`--dry-run` still runs hardware detection (read-only) and the full policy pass, so it is an
honest preview of exactly what would be written — including warnings and consent findings.

## Scripting example

```powershell
# Refuse to continue unless the machine matches and the plan is clean
if ((tunesmith-cli apply --preset competitive-fps-low-latency --dry-run --json | Out-String | ConvertFrom-Json).blocked) {
  throw 'preset blocked on this machine'
}

$out = tunesmith-cli apply --preset competitive-fps-low-latency --yes --json | ConvertFrom-Json
if ($out.status -ne 'applied') { throw $out.message }

# … benchmark …

tunesmith-cli rollback --session $out.sessionId
```

## What the CLI will not do

- Run a shell command, script, or arbitrary executable supplied by a preset.
- Bypass an acknowledgement: `--yes`/`--risk` are explicit flags, never implied by `--json`.
- Apply anything while another writer holds the lock.
- Work on a non-Windows host, or without the Windows system tools (`reg.exe`, `sc.exe`,
  `powercfg.exe`, PowerShell) on `PATH`.

## Tests

`tests/cli.test.ts` drives `runCli` with fake dependencies, so argument handling, exit
codes, refusal paths and JSON output are covered without touching the host. The tests use
the **real** `compilePlan` and `presetSchema`; only the system adapter is faked.
