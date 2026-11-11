import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GameLibraryService,
  normaliseEpicManifest,
  normaliseGogEntry,
  normaliseXboxPackage,
  parseSteamLibraryFolders,
  parseSteamManifest,
  parseValveKeyValues,
  scanEpicLibraries,
  scanSteamLibraries,
} from '../src/main/platform/game/libraries';
import { attachProfileMatches, installedProfilePaths, matchProfilesForGame } from '../src/shared/game/library';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { DiscoveredGame, GameProfile } from '../src/shared/game/types';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-library-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function vdfEscape(value: string): string {
  return value.replace(/\\/g, '\\\\');
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

function profile(trigger: Record<string, string>): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'test-profile',
    name: 'Test Profile',
    version: '1.0.0',
    description: 'A profile used to test library discovery and matching.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    trigger,
    actions: { priority: 'High' },
  });
}

function discovered(overrides: Partial<DiscoveredGame> = {}): DiscoveredGame {
  return {
    id: 'steam:1',
    name: 'Test Game',
    source: 'steam',
    appId: '1',
    installDir: 'D:\\SteamLibrary\\steamapps\\common\\Test Game',
    executables: [{ name: 'TestGame.exe', path: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\TestGame.exe' }],
    executablePath: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\TestGame.exe',
    packageFamilyName: null,
    profileIds: [],
    ...overrides,
  };
}

describe('Valve KeyValues parsing', () => {
  it('parses nested objects, quoted values, comments and escaped backslashes', () => {
    const parsed = parseValveKeyValues(`
      // library list
      "libraryfolders"
      {
        "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }
        "1" { "path" "D:\\\\SteamLibrary" "label" "games" }
      }
    `);

    const folders = parsed.libraryfolders;
    expect(typeof folders).toBe('object');
    if (typeof folders !== 'object') throw new Error('missing libraryfolders');
    expect((folders['1'] as { path?: string }).path).toBe('D:\\SteamLibrary');
  });

  it('extracts every library root from libraryfolders.vdf', () => {
    const paths = parseSteamLibraryFolders(`
      "libraryfolders"
      {
        "contentstatsid" "123"
        "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" }
        "1" { "path" "D:\\\\SteamLibrary" }
      }
    `);
    expect(paths).toEqual(['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  });

  it('parses an app manifest and rejects traversal in installdir', () => {
    const parsed = parseSteamManifest(`
      "AppState"
      {
        "appid" "1091500"
        "name" "Cyberpunk 2077"
        "installdir" "Cyberpunk 2077"
      }
    `);
    expect(parsed).toEqual({ appId: '1091500', name: 'Cyberpunk 2077', installDir: 'Cyberpunk 2077' });

    expect(
      parseSteamManifest(`"AppState" { "name" "Bad" "installdir" "..\\\\outside" }`),
    ).toBeNull();
  });
});

describe('Steam library scan', () => {
  it('follows libraryfolders.vdf and finds the game executable across both libraries', async () => {
    const root = await tempDir();
    const second = await tempDir();

    await write(
      path.join(root, 'steamapps', 'libraryfolders.vdf'),
      `"libraryfolders"
      {
        "0" { "path" "${vdfEscape(root)}" }
        "1" { "path" "${vdfEscape(second)}" }
      }`,
    );
    await write(
      path.join(root, 'steamapps', 'appmanifest_1091500.acf'),
      `"AppState" { "appid" "1091500" "name" "Cyberpunk 2077" "installdir" "Cyberpunk 2077" }`,
    );
    await write(
      path.join(root, 'steamapps', 'common', 'Cyberpunk 2077', 'unins000.exe'),
      '',
    );
    await write(
      path.join(root, 'steamapps', 'common', 'Cyberpunk 2077', 'bin', 'x64', 'Cyberpunk2077.exe'),
      '',
    );

    await write(
      path.join(second, 'steamapps', 'appmanifest_730.acf'),
      `"AppState" { "appid" "730" "name" "Counter-Strike 2" "installdir" "Counter-Strike Global Offensive" }`,
    );
    await write(
      path.join(second, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'bin', 'win64', 'cs2.exe'),
      '',
    );

    const games = await scanSteamLibraries([root]);
    const cyberpunk = games.find((game) => game.name === 'Cyberpunk 2077');
    const cs2 = games.find((game) => game.name === 'Counter-Strike 2');

    expect(cyberpunk?.executablePath).toBe(
      path.join(root, 'steamapps', 'common', 'Cyberpunk 2077', 'bin', 'x64', 'Cyberpunk2077.exe'),
    );
    expect(cyberpunk?.executables[0]?.name).toBe('Cyberpunk2077.exe');
    expect(cs2?.executablePath).toBe(
      path.join(second, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'bin', 'win64', 'cs2.exe'),
    );
    expect(cs2?.source).toBe('steam');
  });

  it('skips malformed manifests and installdir traversal', async () => {
    const root = await tempDir();
    await write(path.join(root, 'steamapps', 'appmanifest_1.acf'), 'not a manifest');
    await write(
      path.join(root, 'steamapps', 'appmanifest_2.acf'),
      `"AppState" { "appid" "2" "name" "Escape" "installdir" "..\\\\outside" }`,
    );

    await expect(scanSteamLibraries([root])).resolves.toEqual([]);
  });
});

describe('Epic library scan', () => {
  it('maps the manifest LaunchExecutable to an absolute path', async () => {
    const root = await tempDir();
    const install = path.join(root, 'Game');
    const manifests = path.join(root, 'Manifests');
    await write(path.join(install, 'bin', 'Game.exe'), '');
    await write(
      path.join(manifests, 'Game.item'),
      JSON.stringify({
        DisplayName: 'Epic Game',
        AppName: 'EpicGame',
        InstallLocation: install,
        LaunchExecutable: 'bin\\Game.exe',
      }),
    );

    const games = await scanEpicLibraries([manifests]);
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      id: 'epic:EpicGame',
      name: 'Epic Game',
      source: 'epic',
      executablePath: path.join(install, 'bin', 'Game.exe'),
    });
  });

  it('rejects relative install locations', () => {
    expect(normaliseEpicManifest({ DisplayName: 'Bad', InstallLocation: 'relative' })).toBeNull();
  });

  it('ignores a LaunchExecutable outside the install directory', async () => {
    const root = await tempDir();
    const install = path.join(root, 'Game');
    const manifests = path.join(root, 'Manifests');
    await write(path.join(install, 'Game.exe'), '');
    await write(path.join(root, 'evil.exe'), '');
    await write(
      path.join(manifests, 'Game.item'),
      JSON.stringify({
        DisplayName: 'Epic Game',
        AppName: 'EpicGame',
        InstallLocation: install,
        LaunchExecutable: '..\\evil.exe',
      }),
    );

    const games = await scanEpicLibraries([manifests]);
    expect(games[0]?.executablePath).toBe(path.join(install, 'Game.exe'));
    expect(games[0]?.executables.map((entry) => entry.path)).not.toContain(path.join(root, 'evil.exe'));
  });
});

describe('GOG and Xbox manifest normalisation', () => {
  it('normalises GOG registry values', () => {
    expect(
      normaliseGogEntry({
        gameName: 'The Witcher 3',
        gameID: '1207658924',
        path: 'D:\\GOG Games\\The Witcher 3',
        exe: 'bin\\witcher3.exe',
      }),
    ).toEqual({
      gameId: '1207658924',
      name: 'The Witcher 3',
      installDir: 'D:\\GOG Games\\The Witcher 3',
      exe: 'bin\\witcher3.exe',
    });
    expect(normaliseGogEntry({ gameName: 'Bad', path: 'D:\\GOG\\..\\evil' })).toBeNull();
  });

  it('normalises a Store package to bare executable names', () => {
    expect(
      normaliseXboxPackage({
        familyName: 'Microsoft.Game_8wekyb3d8bbwe',
        name: 'Xbox Game',
        installLocation: 'C:\\XboxGames\\Game',
        executables: ['bin\\game.exe', 'GameLauncher.EXE', 'not-an-exe.txt'],
      }),
    ).toEqual({
      familyName: 'Microsoft.Game_8wekyb3d8bbwe',
      name: 'Xbox Game',
      installDir: 'C:\\XboxGames\\Game',
      executables: ['game.exe', 'GameLauncher.EXE'],
    });
    expect(normaliseXboxPackage({ familyName: '../bad', installLocation: 'C:\\Games' })).toBeNull();
  });
});

describe('profile matching', () => {
  it('matches an executable name and requires the install path prefix', () => {
    const matching = profile({ exe: 'TestGame.exe', pathPrefix: 'D:\\SteamLibrary' });
    const wrongDrive = profile({ exe: 'TestGame.exe', pathPrefix: 'E:\\SteamLibrary' });

    expect(matchProfilesForGame(discovered(), [matching])).toEqual([matching]);
    expect(matchProfilesForGame(discovered(), [wrongDrive])).toEqual([]);
  });

  it('matches a packaged title by package family name', () => {
    const matching = profile({ packageFamilyName: 'Microsoft.Game_8wekyb3d8bbwe' });
    const xbox = discovered({
      source: 'xbox',
      packageFamilyName: 'Microsoft.Game_8wekyb3d8bbwe',
      executables: [{ name: 'Game.exe', path: 'C:\\XboxGames\\Game\\Game.exe' }],
      executablePath: 'C:\\XboxGames\\Game\\Game.exe',
    });

    expect(matchProfilesForGame(xbox, [matching])).toEqual([matching]);
  });

  it('attaches profile ids without mutating the scan and maps installed paths', () => {
    const matching = profile({ exe: 'TestGame.exe' });
    const scan = {
      scannedAt: '2026-01-01T00:00:00.000Z',
      errors: [],
      games: [discovered()],
    };

    const attached = attachProfileMatches(scan, [matching]);
    expect(attached.games[0]?.profileIds).toEqual(['test-profile']);
    expect(scan.games[0]?.profileIds).toEqual([]);
    expect(installedProfilePaths(attached, [matching])).toEqual(
      new Map([['test-profile', 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\TestGame.exe']]),
    );
  });
});

describe('GameLibraryService', () => {
  it('scans only the sources it is given and caches until forced', async () => {
    const root = await tempDir();
    await write(
      path.join(root, 'steamapps', 'appmanifest_1.acf'),
      `"AppState" { "appid" "1" "name" "Test Game" "installdir" "Test Game" }`,
    );
    await write(path.join(root, 'steamapps', 'common', 'Test Game', 'TestGame.exe'), '');

    const service = new GameLibraryService({
      steamRoots: [root],
      epicManifestDirs: [],
      includeXbox: false,
      includeGog: false,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const first = await service.scan();
    expect(first.scannedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(first.games.map((game) => game.name)).toEqual(['Test Game']);
    expect(first.errors).toEqual([]);

    await write(
      path.join(root, 'steamapps', 'appmanifest_2.acf'),
      `"AppState" { "appid" "2" "name" "Second Game" "installdir" "Second Game" }`,
    );
    await write(path.join(root, 'steamapps', 'common', 'Second Game', 'SecondGame.exe'), '');

    expect((await service.scan()).games).toHaveLength(1);
    expect((await service.scan(true)).games).toHaveLength(2);
  });
});
