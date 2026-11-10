/**
 * Durable, append-only session journal.
 *
 * Invariants
 *  1. A target is never mutated until an `entry` record containing its exact prior
 *     state is on disk and fsync'd. If the write fails, the mutation does not happen.
 *  2. The log is append-only; outcomes are additional records, never rewrites. A
 *     truncated or corrupt trailing line therefore loses at most one outcome, and the
 *     step is then treated as "announced, probably applied" and rolled back.
 *  3. `manifest.json` is written atomically (tmp + rename) so a crash cannot leave a
 *     half-written status.
 *
 * This module deliberately has no Electron dependency: `root` is injected so tests can
 * drive it against a temp directory.
 */
import { closeSync, openSync, writeSync, fsyncSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
  JournalEntry,
  JournalRecord,
  SessionManifest,
  SessionStatus,
  SessionSummary,
} from '../../shared/session';

const MANIFEST = 'manifest.json';
const JOURNAL = 'journal.jsonl';

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** Merge append-only records into the current view of each step. */
/**
 * Steps that may still hold a mutation on the machine.
 *
 * `failed` is included deliberately: an action can fail *after* its first system call
 * succeeded (service startup changed, then stop failed). Restoring it is idempotent, so
 * the conservative choice is to always attempt it.
 */
export function isRestorable(entry: JournalEntry): boolean {
  return entry.status === 'applied' || entry.status === 'pending' || entry.status === 'failed';
}

export function reduceJournal(records: readonly JournalRecord[]): JournalEntry[] {
  const map = new Map<number, JournalEntry>();

  for (const record of records) {
    if (record.type === 'entry') {
      map.set(record.seq, { ...record.entry, status: 'pending' });
      continue;
    }
    const existing = map.get(record.seq);
    if (existing === undefined) continue;

    if (record.type === 'outcome') {
      existing.status = record.status;
      if (record.error !== undefined) existing.error = record.error;
    } else {
      existing.rolledBack = record.ok;
      if (!record.ok && record.error !== undefined) existing.error = record.error;
    }
  }

  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export class JournalStore {
  readonly root: string;
  private handles = new Map<string, FileHandle>();

  constructor(root: string) {
    this.root = root;
  }

  sessionDir(sessionId: string): string {
    return path.join(this.root, sessionId);
  }

  async createSession(manifest: SessionManifest): Promise<void> {
    const dir = this.sessionDir(manifest.id);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, MANIFEST), manifest);
    // Touch the journal so an empty session is still a valid, readable record.
    await writeFile(path.join(dir, JOURNAL), '', 'utf8');
  }

  async append(sessionId: string, record: JournalRecord): Promise<void> {
    const file = path.join(this.sessionDir(sessionId), JOURNAL);
    let handle = this.handles.get(sessionId);
    if (handle === undefined) {
      handle = await open(file, 'a');
      this.handles.set(sessionId, handle);
    }
    await handle.write(`${JSON.stringify(record)}\n`);
    // Durability over throughput: at most a few hundred records per session.
    await handle.sync();
  }

  async readManifest(sessionId: string): Promise<SessionManifest> {
    const raw = await readFile(path.join(this.sessionDir(sessionId), MANIFEST), 'utf8');
    return JSON.parse(raw) as SessionManifest;
  }

  async updateManifest(sessionId: string, patch: Partial<SessionManifest>): Promise<SessionManifest> {
    const current = await this.readManifest(sessionId);
    const next: SessionManifest = { ...current, ...patch };
    await writeJsonAtomic(path.join(this.sessionDir(sessionId), MANIFEST), next);
    return next;
  }

  async readRecords(sessionId: string): Promise<JournalRecord[]> {
    let raw: string;
    try {
      raw = await readFile(path.join(this.sessionDir(sessionId), JOURNAL), 'utf8');
    } catch {
      return [];
    }

    const records: JournalRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as JournalRecord);
      } catch {
        // A partially written trailing line is expected after a hard power loss.
        // Everything before it is still valid and sufficient to roll back.
        break;
      }
    }
    return records;
  }

  async entries(sessionId: string): Promise<JournalEntry[]> {
    return reduceJournal(await this.readRecords(sessionId));
  }

  async listManifests(): Promise<SessionManifest[]> {
    let dirs: string[];
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    const manifests: SessionManifest[] = [];
    for (const dir of dirs) {
      try {
        manifests.push(await this.readManifest(dir));
      } catch {
        // Ignore directories without a readable manifest.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async summaries(): Promise<SessionSummary[]> {
    const manifests = await this.listManifests();
    const out: SessionSummary[] = [];

    for (const manifest of manifests) {
      const entries = await this.entries(manifest.id);
      const pendingRollback = entries.filter((e) => isRestorable(e) && e.rolledBack !== true).length;

      out.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        finishedAt: manifest.finishedAt,
        presetId: manifest.presetId,
        presetName: manifest.presetName,
        presetVersion: manifest.presetVersion,
        presetRisk: manifest.presetRisk,
        signature: manifest.signature,
        status: manifest.status,
        restorePoint: manifest.restorePoint,
        stepCount: manifest.stepCount,
        pendingRollback,
        interrupted: manifest.status === 'applying',
      });
    }
    return out;
  }

  /** Sessions that still have changes on the machine (or were cut off mid-apply). */
  async sessionsNeedingRollback(): Promise<SessionSummary[]> {
    const all = await this.summaries();
    return all.filter(
      (s) => (s.status === 'applying' || s.status === 'applied' || s.status === 'rollback-failed') && s.pendingRollback > 0,
    );
  }

  async close(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (handle === undefined) return;
    this.handles.delete(sessionId);
    await handle.close();
  }

  async closeAll(): Promise<void> {
    for (const [id, handle] of this.handles) {
      this.handles.delete(id);
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Cheap writability probe used by preflight: a journal that cannot be written means
   * no mutation is safe, because there would be nothing to roll back from.
   */
  async isWritable(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, '.write-probe');
      await writeFile(probe, 'ok', 'utf8');
      const fd = openSync(probe, 'r+');
      try {
        writeSync(fd, 'ok');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      await rename(probe, path.join(this.root, '.write-probe-ok'));
      return { ok: true, detail: this.root };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

export function newSessionManifest(input: {
  id: string;
  presetId: string;
  presetName: string;
  presetVersion: string;
  presetRisk: string;
  signature: string;
  appVersion: string;
  stepCount: number;
}): SessionManifest {
  return {
    id: input.id,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    presetId: input.presetId,
    presetName: input.presetName,
    presetVersion: input.presetVersion,
    presetRisk: input.presetRisk,
    signature: input.signature,
    appVersion: input.appVersion,
    status: 'applying',
    restorePoint: { attempted: false, ok: false, detail: 'not attempted' },
    stepCount: input.stepCount,
    notes: [],
  };
}

export function statusNeedsRollback(status: SessionStatus): boolean {
  return status === 'applying' || status === 'applied' || status === 'rollback-failed';
}
