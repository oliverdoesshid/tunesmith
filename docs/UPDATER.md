# GitHub Releases auto-update

> Scope: packaged Windows builds. Development builds never contact the update feed.

## 1. Runtime flow

`src/main/updater.ts` owns an `electron-updater` `autoUpdater` plus a dedicated
`electron-log` file sink:

```
app.whenReady
  -> create UpdaterService
     -> write userData/logs/updater.log, max 5 MiB, one rotated .old.log
     -> register electron-updater event listeners
  -> create the main window
  -> start()
       packaged only
       -> check after 5 s
       -> check again every 6 h
```

The GitHub provider is not supplied by the renderer. electron-builder writes
`resources/app-update.yml` from the package publish block:

```yaml
owner: oliverdoesshid
repo: tunesmith
provider: github
updaterCacheDirName: tunesmith-updater
```

A check reports `checking`, then either `up-to-date`, `available`/`downloading`/
`downloaded`, or `error`. `autoDownload` is enabled, so a newer release downloads
automatically; `autoInstallOnAppQuit` is disabled so an update is not installed on exit
without the explicit install request.

## 2. Renderer contract

The renderer receives only `UpdaterStatus` from `src/shared/updater.ts`: phase, versions,
percentage, bytes per second, a display message and timestamps. It never receives a feed URL,
download path, certificate, token or installer argument.

| Direction | Channel | Result |
|---|---|---|
| invoke | `tunesmith:update-status` | current status |
| invoke | `tunesmith:check-update` | disabled status in development; otherwise a feed check |
| invoke | `tunesmith:install-update` | install after `update-downloaded`; otherwise an error |
| push | `tunesmith:update-status-changed` | status updates for the footer |

The renderer's footer shows checking/downloading progress, a ready state, and an
`Install update` button only after the download finishes. The install handler accepts no
payload, refuses while a game session is active, and calls `quitAndInstall(false, true)`;
`before-quit` still restores an active game session before the process exits.

## 3. Release workflow

`.github/workflows/release.yml` runs on a tag matching `v*.*.*`:

1. checkout and Node 20 with npm caching;
2. verify the tag equals `v` + `package.json.version`;
3. `npm ci`;
4. `npm run build`;
5. `npx electron-builder --win --publish always`, with
   `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: contents: write`;
6. `gh release edit "$GITHUB_REF_NAME" --draft=false`, which also recovers a release
   left in draft state by an interrupted earlier run.

electron-builder creates a published (not draft) GitHub release and uploads:

- `TuneSmith-Setup-<version>.exe` — the NSIS installer;
- `latest.yml` — version, SHA-512, filename and release date.

The publish config sets `releaseType: "release"`; without it electron-builder defaults to a
draft release, which `electron-updater` would not see. The workflow's final `gh release edit`
step and `EP_GH_IGNORE_TIME=true` make retries upload to, and publish, the existing tag release.
The artifact name is deliberately hyphenated so `latest.yml`'s `url` matches the actual
uploaded asset. A build without a Windows signing certificate is unsigned; electron-builder
logs that it skipped signing.

## 4. Logging and rotation

`electron-log` is configured before any check:

- path: `%APPDATA%\TuneSmith\logs\updater.log` through `app.getPath('userData')`;
- level: `info`;
- maximum size: 5 MiB;
- rotation: electron-log moves the full file to `updater.old.log` and starts a fresh file.

The app's existing `tunesmith.log` rotation remains separate. The updater log keeps the
underlying error detail for diagnosis; the renderer-facing status uses a sanitized summary so
feed URLs and installer paths do not cross the bridge.

## 5. Safety properties

- `app.isPackaged` gates the scheduled check, the renderer check and the install method.
- The feed source is compiled into `app-update.yml`, not accepted from IPC.
- Installation is refused until the service has observed `update-downloaded`.
- `quitAndInstall` is invoked with fixed arguments; no renderer payload reaches it.
- electron-updater verifies the installer digest published in `latest.yml`.
- The service has no filesystem path parameter and never executes a renderer-supplied file.

Code signing is still recommended before production. Without it, a compromised GitHub
release or a leaked maintenance token can publish a malicious, digest-matching installer;
HTTPS and the digest check do not establish publisher identity.

## 6. Verification and limitations

Verified during development:

- `npm run typecheck`;
- `npm test` — 427 tests across 44 files; updater tests cover packaged/development gating,
  event-to-status mapping, progress rounding, install refusal before download, active-game
  refusal at the IPC boundary, feed errors, ready-state protection and timer lifecycle;
- `npm run build` — main bundle includes electron-updater/electron-log;
- `npx electron-builder --win --x64 --publish never` — NSIS installer and `latest.yml` generated;
- generated `latest.yml` filename matches the installer, and `app-update.yml` contains the
  GitHub owner/repository.

Not performed here: publishing a real tag, downloading from the live GitHub feed, installing
an update, or validating an Authenticode signature. Those require a supervised release pass.
