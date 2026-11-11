/**
 * Single-writer lock around the whole engine.
 *
 * A tuning session mutates global OS state, so two of them must never interleave, even
 * across two app windows or two processes. `mkdir` is used as the mutex because it is
 * atomic on NTFS and needs no extra dependency.
 *
 * A crashed session can leave the directory behind, so a stale holder (older than
 * `staleMs`) is broken once, loudly logged, and replaced.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TuneSmithError } from '../../shared/errors';

interface LockHolder {
  pid: number;
  startedAt: string;
  reason: string;
}

export class SessionLock {
  private readonly dir: string;
  private readonly staleMs: number;
  private held = false;

  constructor(root: string, staleMs = 10 * 60 * 1000) {
    // The lock lives beside the session directories, matching the documented layout
    // `sessions/lock`. `root` is the Electron user-data directory / CLI --user-data.
    this.dir = path.join(root, 'sessions', 'lock');
    this.staleMs = staleMs;
  }

  async currentHolder(): Promise<LockHolder | null> {
    try {
      const raw = await readFile(path.join(this.dir, 'holder.json'), 'utf8');
      return JSON.parse(raw) as LockHolder;
    } catch {
      return null;
    }
  }

  async acquire(reason: string): Promise<void> {
    // `sessions/` normally exists because the journal creates it, but preflight can
    // acquire before the first session. Create the parent so the first mkdir is the
    // actual mutex attempt rather than an ENOENT failure.
    await mkdir(path.dirname(this.dir), { recursive: true });
    try {
      await mkdir(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      const holder = await this.currentHolder();
      const ageMs = await this.lockAgeMs(holder);
      if (ageMs < this.staleMs) {
        throw new TuneSmithError(
          'locked',
          'Another tuning session is already running.',
          holder === null ? 'lock directory exists without a holder record' : `held by pid ${holder.pid} since ${holder.startedAt}`,
        );
      }

      console.warn(
        `[lock] breaking stale lock at ${this.dir} (${holder === null ? 'missing holder record' : `pid ${holder.pid} since ${holder.startedAt}`}); older than ${this.staleMs}ms`,
      );
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir);
    }

    const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString(), reason };
    await writeFile(path.join(this.dir, 'holder.json'), `${JSON.stringify(holder, null, 2)}\n`, 'utf8');
    this.held = true;
  }

  /**
   * Age of the lock. A process can die between `mkdir` and writing `holder.json`, so a
   * missing holder is not automatically stale: fall back to the directory's mtime.
   * Only a genuinely old lock is broken, which closes the window where two writers
   * could both decide an empty lock directory is abandoned.
   */
  private async lockAgeMs(holder: LockHolder | null): Promise<number> {
    if (holder !== null) {
      const started = Date.parse(holder.startedAt);
      return Number.isFinite(started) ? Date.now() - started : Number.POSITIVE_INFINITY;
    }
    try {
      const info = await stat(this.dir);
      return Date.now() - info.mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await rm(this.dir, { recursive: true, force: true });
  }

  get isHeld(): boolean {
    return this.held;
  }
}
