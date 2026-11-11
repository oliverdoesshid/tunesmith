/**
 * Durable health baseline and pinned-preset preference.
 *
 * This file lives under Electron's userData directory, never inside a system path. The
 * baseline is written atomically (fsync + rename) because a half-written baseline would
 * make the next launch report a fake OS change.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { HealthSnapshot } from '../../shared/health/types';

interface HealthSettings {
  schemaVersion: 1;
  pinnedPresetId: string | null;
}

const PINNED_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is HealthSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.capturedAt !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.warnings)) {
    return false;
  }
  if (!isRecord(value.os) || typeof value.os.build !== 'string') return false;
  if (!isRecord(value.servicing)) return false;
  return (
    typeof value.servicing.rebootPending === 'boolean' &&
    typeof value.servicing.packagesPending === 'boolean' &&
    typeof value.servicing.windowsUpdateReboot === 'boolean' &&
    typeof value.servicing.pendingFileRename === 'boolean'
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);

  try {
    const directory = await open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows may not allow opening a directory; the fsynced temp + rename is atomic.
  }
}

export class HealthStore {
  private readonly dir: string;

  constructor(userDataDir: string) {
    this.dir = path.join(userDataDir, 'health');
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async loadBaseline(): Promise<HealthSnapshot | null> {
    try {
      const raw = await readFile(path.join(this.dir, 'baseline.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async saveBaseline(snapshot: HealthSnapshot): Promise<void> {
    await this.ensureDir();
    await writeJsonAtomic(path.join(this.dir, 'baseline.json'), snapshot);
  }

  async loadSettings(): Promise<HealthSettings> {
    try {
      const raw = await readFile(path.join(this.dir, 'settings.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const id = isRecord(parsed) ? parsed.pinnedPresetId : null;
      return {
        schemaVersion: 1,
        pinnedPresetId: typeof id === 'string' && PINNED_ID_RE.test(id) ? id : null,
      };
    } catch {
      return { schemaVersion: 1, pinnedPresetId: null };
    }
  }

  async saveSettings(settings: HealthSettings): Promise<void> {
    await this.ensureDir();
    await writeJsonAtomic(path.join(this.dir, 'settings.json'), settings);
  }
}
