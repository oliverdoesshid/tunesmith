/**
 * Manually added games.
 *
 * The launcher's automatic discovery only knows about Steam, Epic, Xbox and GOG
 * manifests. This store lets the user add a local title that those launchers do not
 * expose, while keeping the same launch contract: both paths are absolute, the
 * executable is inside the install directory, and the renderer never supplies a path
 * directly to `shell.openPath`.
 *
 * The list is deliberately small and stored next to the other user data. A malformed
 * file is reported and never overwritten; the user can remove it to reset the list.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { TuneSmithError } from '../../../shared/errors';
import type { DiscoveredGame, ManualGameInput } from '../../../shared/game/types';
import { isInsideGameFolder, normaliseGamePath } from '../../services/game-files';

export const MANUAL_GAME_LIMIT = 100;

const recordSchema = z.strictObject({
  id: z.string().regex(/^manual:[A-Za-z0-9-]{8,64}$/),
  name: z.string().trim().min(1).max(160),
  installDir: z.string().min(3).max(32_767),
  executablePath: z.string().min(3).max(32_767),
});

const fileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  games: z.array(recordSchema).max(MANUAL_GAME_LIMIT),
});

type ManualGameRecord = z.infer<typeof recordSchema>;

export interface ManualGameLoadResult {
  games: DiscoveredGame[];
  errors: { source: 'manual'; message: string }[];
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDiscoveredGame(record: ManualGameRecord): DiscoveredGame {
  return {
    id: record.id,
    name: record.name,
    source: 'manual',
    appId: null,
    installDir: record.installDir,
    executables: [{ name: path.win32.basename(record.executablePath), path: record.executablePath }],
    executablePath: record.executablePath,
    packageFamilyName: null,
    profileIds: [],
  };
}

export class ManualGameStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ManualGameLoadResult> {
    const { records, errors } = await this.read();

    if (errors.length > 0) return { games: [], errors };

    const games: DiscoveredGame[] = [];
    const pathErrors: ManualGameLoadResult['errors'] = [];
    for (const record of records) {
      const installDir = normaliseGamePath(record.installDir);
      const executablePath = normaliseGamePath(record.executablePath);
      if (
        installDir === null ||
        executablePath === null ||
        !executablePath.toLowerCase().endsWith('.exe') ||
        !isInsideGameFolder(installDir, executablePath)
      ) {
        pathErrors.push({
          source: 'manual',
          message: `Manual entry "${record.name}" has an unsafe install or executable path and was skipped.`,
        });
        continue;
      }
      games.push(toDiscoveredGame({ ...record, installDir, executablePath }));
    }

    return { games, errors: pathErrors };
  }

  async add(input: ManualGameInput): Promise<DiscoveredGame> {
    const { records, errors } = await this.read();
    if (errors.length > 0) {
      throw new TuneSmithError(
        'unavailable',
        'The manual game list is unreadable. Remove or fix the stored list before adding a game.',
      );
    }
    if (records.length >= MANUAL_GAME_LIMIT) {
      throw new TuneSmithError(
        'invalid-request',
        `The manual game list is full (${MANUAL_GAME_LIMIT} entries). Remove a game first.`,
      );
    }

    const name = input.name.trim();
    const hasControlCharacter = [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    if (name.length === 0 || name.length > 160 || hasControlCharacter) {
      throw new TuneSmithError('invalid-request', 'Give the game a name between 1 and 160 characters.');
    }

    const installDir = normaliseGamePath(input.installDir);
    if (installDir === null) {
      throw new TuneSmithError('invalid-request', 'The install folder must be an absolute path on a local drive.');
    }
    const executablePath = normaliseGamePath(input.executablePath);
    if (executablePath === null || !executablePath.toLowerCase().endsWith('.exe')) {
      throw new TuneSmithError('invalid-request', 'Choose an absolute path to a local .exe file.');
    }
    if (!isInsideGameFolder(installDir, executablePath)) {
      throw new TuneSmithError('invalid-request', 'The executable must be inside the game install folder.');
    }

    const [installInfo, executableInfo] = await Promise.all([
      stat(installDir).catch(() => null),
      stat(executablePath).catch(() => null),
    ]);
    if (installInfo === null || !installInfo.isDirectory()) {
      throw new TuneSmithError('unavailable', 'The install folder does not exist or is not a directory.');
    }
    if (executableInfo === null || !executableInfo.isFile()) {
      throw new TuneSmithError('unavailable', 'The executable does not exist or is not a file.');
    }

    if (
      records.some(
        (record) =>
          normaliseGamePath(record.installDir)?.toLowerCase() === installDir.toLowerCase() &&
          normaliseGamePath(record.executablePath)?.toLowerCase() === executablePath.toLowerCase(),
      )
    ) {
      throw new TuneSmithError('invalid-request', 'That game is already in the manual launcher list.');
    }

    const record: ManualGameRecord = {
      id: `manual:${randomUUID()}`,
      name,
      installDir,
      executablePath,
    };
    await this.write([...records, record]);
    return toDiscoveredGame(record);
  }

  async remove(gameId: string): Promise<boolean> {
    if (!/^manual:[A-Za-z0-9-]{8,64}$/.test(gameId)) return false;

    const { records, errors } = await this.read();
    if (errors.length > 0) {
      throw new TuneSmithError(
        'unavailable',
        'The manual game list is unreadable. Remove or fix the stored list before changing it.',
      );
    }

    const next = records.filter((record) => record.id !== gameId);
    if (next.length === records.length) return false;
    await this.write(next);
    return true;
  }

  private async read(): Promise<{ records: ManualGameRecord[]; errors: ManualGameLoadResult['errors'] }> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return { records: [], errors: [] };
      return {
        records: [],
        errors: [{ source: 'manual', message: `The manual game list could not be read: ${errorMessage(error)}` }],
      };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return {
        records: [],
        errors: [{ source: 'manual', message: 'The manual game list is not valid JSON. Remove it to reset the list.' }],
      };
    }

    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        records: [],
        errors: [{ source: 'manual', message: 'The manual game list is malformed. Remove it to reset the list.' }],
      };
    }
    return { records: parsed.data.games, errors: [] };
  }

  private async write(records: readonly ManualGameRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ schemaVersion: 1, games: records }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
