# Shader cache health

> Scope: the read-only cache inventory and the one supported mutation — deleting a whole,
> metadata-proven orphaned DirectX `.dxcache` file. This is not a preset action and never runs
> automatically.

## 1. What is shown

The main process resolves these fixed roots under the current user's `%LOCALAPPDATA%`; the
renderer never supplies a path:

| Id | Root | Provider | Orphan analysis |
|---|---|---|---|
| `directx` | `D3DSCache` | DirectX | SQLite `app_id` metadata |
| `nvidia-dx` | `NVIDIA\DXCache` | NVIDIA | none — opaque |
| `nvidia-gl` | `NVIDIA\GLCache` | NVIDIA | none — opaque |
| `nvidia-vk` | `NVIDIA\VkCache` | NVIDIA | none — opaque |
| `amd-dx` | `AMD\DxCache` | AMD | none — opaque |
| `amd-dxc` | `AMD\DxcCache` | AMD | none — opaque |
| `amd-gl` | `AMD\GLCache` | AMD | none — opaque |
| `amd-vk` | `AMD\VkCache` | AMD | none — opaque |

A missing vendor directory is normal (AMD directories are absent on an NVIDIA machine, and
vice versa). The panel reports it as absent rather than as an error.

For each root the scan reports the file count, total bytes, newest modification time, whether
the root exists/reads, and any bounded warnings. A scan is read-only: it `lstat`s entries,
refuses symbolic links, walks at most five directory levels and caps the inventory at 12,000
files per root. Unreadable subdirectories become warnings, not crashes.

The renderer receives display paths only for information. Every prune request carries closed
cache ids; the IPC schema accepts exactly `["directx"]` and `confirm: true`.

## 2. What "orphaned" means

DirectX cache files end in `.dxcache` and are SQLite databases. Their `app_id` table records the
executable paths whose pipelines the file contains. A file is classified as orphaned only when
all of the following hold:

1. it is a regular file, not a symlink, at a fixed root;
2. it is older than 24 hours;
3. it has a readable `app_id` table with 1–256 rows;
4. every `exe_path` is an absolute drive path; and
5. **none** of those executables exists.

Anything else is left alone. That includes a file with one live app and one removed app, a
zero-row table, a table with more than 256 rows, an unexpected path shape, a file without
`app_id`, and any read/decode failure. The conservative rule is deliberate: deleting one game's
valid pipelines to remove another game's stale rows would trade a storage win for a stutter.

A file with multiple `app_id` rows is never partially edited. SQLite internals are an
implementation detail of the driver; the app does not delete rows or compact the database.

## 3. Prune transaction

The UI requires two clicks: `Prune orphaned` arms the action, then `Confirm orphan prune`
sends the request. The IPC handler also requires `confirm: true` and rejects pruning while a
game session is active.

For every candidate the service re-checks, immediately before `unlink`:

- `lstat` still reports a regular file and not a symlink;
- size and `mtimeMs` match the inventory record (the cache did not change between scan and
  click);
- the file is still older than 24 hours;
- the SQLite metadata still classifies it as orphaned.

A changed file is skipped, not deleted. Directories and vendor caches are refused at the
service boundary as well as by the IPC schema. The service returns a fresh inventory and a
message; warnings make `ok` false even if some files were removed, so the UI does not report a
partial failure as clean.

Deleting a DirectX cache file is safe in the sense that DirectX will rebuild missing pipelines,
but the affected title can recompile them on its next launch and hitch once. The panel says so;
no before/after frame-time improvement is claimed.

## 4. Why NVIDIA and AMD are monitor-only

Their cache files are hashed driver blobs with no stable mapping to a game or executable.
There is no metadata that proves a whole vendor file is orphaned, and filename/age guessing
could discard valid precompiled pipelines. TuneSmith therefore reports their count and size
but never deletes, renames or edits them. A future vendor format could be added only with a
documented, re-verified mapping and the same re-check-before-delete discipline.

## 5. Limits and failure modes

- **DirectX only** for cleanup; vendor caches are inventory-only.
- **24-hour grace period** means a just-uninstalled game's cache is not removed immediately.
- **Cache metadata is an internal driver detail.** Missing, oversized or malformed metadata is
  treated as unknown and preserved.
- **Whole-file only.** A file containing one live app is retained in full, so some stale rows
  can remain.
- **No background task.** The panel scans on load and on demand; there is no service, scheduled
  task or automatic deletion.
- **No elevation.** The operation reads and deletes files owned by the current user under
  LocalAppData; it does not need administrator rights and does not request them.
- **Not live-pruned during development.** The read-only inventory was exercised against a real
  Windows cache; the delete path is covered by temp SQLite fixtures for live-app, recent,
  unknown-metadata and vendor cases. A real deletion should still be a supervised first run.

## 6. Tests

`tests/shader-cache.test.ts` covers:

- a whole-file orphan with missing executables;
- a live-app file and a mixed live/removed file that must be preserved;
- a recent file inside the grace period;
- a SQLite file without `app_id` (unknown, preserved);
- an opaque NVIDIA file that is counted but never deleted;
- the prune path, plus a cache that gains a live app after the inventory and must be kept;
- refusal of vendor prune ids and absent roots.

`tests/shader-cache-panel.test.tsx` covers the inventory, disabled empty state and the two-click
confirmation. `test/game-launcher.test.ts` covers the IPC schema, confirmation requirement,
active-session refusal and routing to the service.
