import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManualGameStore } from '../src/main/platform/game/manual-games';
import { GameLibraryService } from '../src/main/platform/game/libraries';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-manual-games-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The production path validator intentionally accepts only Windows drive paths.
describe.skipIf(process.platform !== 'win32')('manual game store', () => {
  it('adds, reloads and removes a validated manual game', async () => {
    const root = await tempDir();
    const installDir = path.join(root, 'My Game');
    const executablePath = path.join(installDir, 'Game.exe');
    await mkdir(installDir, { recursive: true });
    await writeFile(executablePath, '');
    const store = new ManualGameStore(path.join(root, 'manual-games.json'));

    const added = await store.add({ name: 'My Game', installDir, executablePath });
    expect(added).toMatchObject({
      name: 'My Game',
      source: 'manual',
      appId: null,
      installDir,
      executablePath,
      executables: [{ name: 'Game.exe', path: executablePath }],
    });
    expect(added.id).toMatch(/^manual:/);

    const loaded = await store.load();
    expect(loaded.errors).toEqual([]);
    expect(loaded.games).toHaveLength(1);
    expect(loaded.games[0]?.id).toBe(added.id);

    const stored = JSON.parse(await readFile(path.join(root, 'manual-games.json'), 'utf8')) as {
      schemaVersion: number;
      games: unknown[];
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.games).toHaveLength(1);

    expect(await store.remove(added.id)).toBe(true);
    expect((await store.load()).games).toEqual([]);
  });

  it('rejects an executable outside the install folder and duplicate entries', async () => {
    const root = await tempDir();
    const installDir = path.join(root, 'Game');
    await mkdir(installDir, { recursive: true });
    const executablePath = path.join(installDir, 'Game.exe');
    const outside = path.join(root, 'outside.exe');
    await writeFile(executablePath, '');
    await writeFile(outside, '');
    const store = new ManualGameStore(path.join(root, 'manual-games.json'));

    await expect(
      store.add({ name: 'Bad', installDir, executablePath: outside }),
    ).rejects.toThrow(/inside the game install folder/i);

    await store.add({ name: 'Game', installDir, executablePath });
    await expect(store.add({ name: 'Duplicate', installDir, executablePath })).rejects.toThrow(/already/i);
  });

  it('merges manual entries into the library scan and invalidates the cache', async () => {
    const root = await tempDir();
    const installDir = path.join(root, 'Scan Game');
    const executablePath = path.join(installDir, 'ScanGame.exe');
    await mkdir(installDir, { recursive: true });
    await writeFile(executablePath, '');
    const store = new ManualGameStore(path.join(root, 'manual-games.json'));
    const service = new GameLibraryService({
      steamRoots: [],
      epicManifestDirs: [],
      includeXbox: false,
      includeGog: false,
      manualGames: store,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const added = await service.addManualGame({ name: 'Scan Game', installDir, executablePath });
    const scan = await service.scan();
    expect(scan.games.map((game) => game.id)).toContain(added.id);

    expect(await service.removeManualGame(added.id)).toBe(true);
    const after = await service.scan(true);
    expect(after.games.map((game) => game.id)).not.toContain(added.id);
  });

  it('reports a malformed file instead of overwriting it', async () => {
    const root = await tempDir();
    const installDir = path.join(root, 'Game');
    const executablePath = path.join(installDir, 'Game.exe');
    await mkdir(installDir, { recursive: true });
    await writeFile(executablePath, '');
    const file = path.join(root, 'manual-games.json');
    await writeFile(file, '{ not json', 'utf8');
    const store = new ManualGameStore(file);

    const loaded = await store.load();
    expect(loaded.games).toEqual([]);
    expect(loaded.errors[0]?.source).toBe('manual');

    await expect(store.add({ name: 'Game', installDir, executablePath })).rejects.toThrow(/unreadable/i);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });
});
