/**
 * Persistence for game mode.
 *
 * Two things are stored, for two different reasons:
 *   - profiles: shipped JSON, validated structurally. A broken file is reported and
 *     skipped, never partially applied.
 *   - sessions: what this app changed while a game was running. Written *before* the
 *     change (same invariant as the tuning engine), because a suspended browser that
 *     outlives a crash is a visible, infuriating bug.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { TuneSmithError } from '../../../shared/errors';
import { formatGameIssues, gameProfileSchema } from '../../../shared/game/schema';
import type { AppliedAdjustment, GameNetworkSnapshot, GameProfile } from '../../../shared/game/types';

export interface ProfileLoadError {
  file: string;
  message: string;
}

export interface LoadedProfiles {
  profiles: GameProfile[];
  errors: ProfileLoadError[];
}

/** A process whose priority or run state this app changed. */
export interface TrackedProcess {
  pid: number;
  exe: string;
  /** Null when the priority could not be read before the change. */
  previousPriority: 'Idle' | 'BelowNormal' | 'Normal' | 'AboveNormal' | 'High' | null;
  suspended: boolean;
  /** True while Windows 11 Efficiency Mode (EcoQoS) is applied to it. */
  ecoMode?: boolean;
}

export interface StoredGameSession {
  schemaVersion: 1;
  id: string;
  profileId: string;
  profileName: string;
  exe: string;
  pid: number | null;
  startedAt: string;
  endedAt?: string;
  phase: 'launching' | 'active' | 'restoring' | 'restored' | 'error';
  /** Present when a per-app GPU preference was changed. */
  gpu?: { exePath: string; previous: string | null };
  /** True while the 0.5 ms timer holder is (or should be) running for this session. */
  timerHeld?: boolean;
  /** Prior TCP/adapter values for the game's server interface(s), captured before writing. */
  network?: GameNetworkSnapshot;
  processes: TrackedProcess[];
  /** Affinity/priority changes on the game itself; they die with the process. */
  game: { affinityApplied: boolean; priorityApplied: boolean };
  adjustments: AppliedAdjustment[];
  restoredAt?: string;
  interrupted?: boolean;
}

export class GameProfileRepository {
  constructor(private readonly dir: string) {}

  async load(): Promise<LoadedProfiles> {
    if (!existsSync(this.dir)) return { profiles: [], errors: [] };

    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (error) {
      throw new TuneSmithError('unavailable', 'Could not read the game profile folder', String(error));
    }

    const files = entries.filter((name) => name.toLowerCase().endsWith('.json')).sort();
    const profiles: GameProfile[] = [];
    const errors: ProfileLoadError[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const full = path.join(this.dir, file);
      let text: string;
      try {
        text = await readFile(full, 'utf8');
      } catch (error) {
        errors.push({ file, message: `Could not read file: ${String(error)}` });
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        errors.push({ file, message: `Invalid JSON: ${String(error)}` });
        continue;
      }

      const parsed = gameProfileSchema.safeParse(json);
      if (!parsed.success) {
        errors.push({ file, message: formatGameIssues(parsed.error) });
        continue;
      }

      if (seen.has(parsed.data.id)) {
        errors.push({ file, message: `Duplicate profile id "${parsed.data.id}"` });
        continue;
      }
      seen.add(parsed.data.id);
      profiles.push(parsed.data);
    }

    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return { profiles, errors };
  }
}

export class GameSessionStore {
  constructor(private readonly dir: string) {}

  newSessionId(): string {
    return randomUUID();
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(session: StoredGameSession): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.fileFor(session.id);
    const temp = `${target}.tmp`;

    // This file is the durable-before-mutate record for suspended processes, GPU state and
    // network captures. Fsync the complete temporary file before the rename, otherwise a
    // power loss can leave a present-but-empty session that recovery cannot trust.
    const handle = await open(temp, 'w');
    try {
      await handle.writeFile(JSON.stringify(session, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Rename over an existing file is not atomic on Windows, so remove first and accept
    // the small window: the content is a snapshot of state we have not changed yet.
    await rm(target, { force: true });
    await rename(temp, target);

    // Best effort, as in the journal: not every Windows filesystem permits opening a
    // directory, but when it does this makes the rename itself durable.
    try {
      const directory = await open(this.dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The fsynced temp file and rename are still ordered.
    }
  }

  async load(id: string): Promise<StoredGameSession | null> {
    try {
      const text = await readFile(this.fileFor(id), 'utf8');
      return JSON.parse(text) as StoredGameSession;
    } catch {
      return null;
    }
  }

  async list(): Promise<StoredGameSession[]> {
    if (!existsSync(this.dir)) return [];
    const entries = (await readdir(this.dir)).filter((name) => name.endsWith('.json'));
    const sessions: StoredGameSession[] = [];

    for (const entry of entries) {
      try {
        const text = await readFile(path.join(this.dir, entry), 'utf8');
        sessions.push(JSON.parse(text) as StoredGameSession);
      } catch {
        // A torn file is skipped: the session is unrecoverable, and pretending otherwise
        // would block every future activation.
      }
    }

    return sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Sessions that were never restored, i.e. work left behind by a crash. */
  async pending(): Promise<StoredGameSession[]> {
    const all = await this.list();
    return all.filter((session) => session.restoredAt === undefined);
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }
}
