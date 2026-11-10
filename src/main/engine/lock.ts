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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    this.dir = path.join(root, 'engine.lock');
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
    try {
      await mkdir(this.dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      const holder = await this.currentHolder();
      const ageMs = holder === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(holder.startedAt);
      if (Number.isFinite(ageMs) && ageMs < this.staleMs) {
        throw new TuneSmithError(
          'locked',
          'Another tuning session is already running.',
          holder === null ? 'lock directory exists without a holder record' : `held by pid ${holder.pid} since ${holder.startedAt}`,
        );
      }

      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir);
    }

    const holder: LockHolder = { pid: process.pid, startedAt: new Date().toISOString(), reason };
    await writeFile(path.join(this.dir, 'holder.json'), `${JSON.stringify(holder, null, 2)}\n`, 'utf8');
    this.held = true;
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
