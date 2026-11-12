/**
 * Game launcher verification.
 *
 * Three layers, each at the boundary that matters:
 *   - path rules: what may be opened/launched at all
 *   - IPC routing: trusted envelope validation and handler dispatch
 *   - SteamGridDB metadata/cache: untrusted response parsing and safe local images
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcEnvelope } from '../src/shared/ipc';
import { IPC_CHANNELS } from '../src/shared/channels';
import type { GameLaunchResult, GameLibraryScanResult, GameStatus, DiscoveredGame } from '../src/shared/game/types';
import type { ArtworkRequestItem, GameArtworkBatch } from '../src/shared/game/artwork';
import type { AppState } from '../src/main/app-state-types';
import type { ShaderCachePruneResult, ShaderCacheStatus } from '../src/shared/shader-cache';
import type { UpdaterStatus } from '../src/shared/updater';
import type { UpdaterService } from '../src/main/updater';
import { idlePostApplyStatus } from '../src/shared/post-apply';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  openPath: vi.fn(async (_target: string) => ''),
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0-test',
    isPackaged: true,
    getAppPath: () => process.cwd(),
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
    ): void => {
      electronMock.handlers.set(channel, handler);
    },
  },
  shell: {
    openPath: electronMock.openPath,
    openExternal: vi.fn(),
  },
  dialog: {
    showOpenDialog: electronMock.showOpenDialog,
  },
}));

import { registerIpcHandlers } from '../src/main/ipc';
import {
  gamePathKey,
  isInsideGameFolder,
  normaliseGamePath,
  resolveGameFolder,
  resolveLaunchExecutable,
} from '../src/main/services/game-files';
import {
  artworkUrl,
  detectImageType,
  isAllowedArtworkUrl,
  resolveArtworkRequestPath,
} from '../src/main/services/artwork-files';
import {
  loadSteamGridDbApiKey,
  normaliseArtworkTitle,
  parseSteamGridDbImages,
  parseSteamGridDbSearch,
  pickArtworkImage,
  pickSearchEntry,
  STEAMGRIDDB_KEY_FILE,
  SteamGridDbService,
  type FetchLike,
} from '../src/main/services/steamgriddb';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-launcher-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  electronMock.handlers.clear();
  electronMock.openPath.mockReset();
  electronMock.openPath.mockResolvedValue('');
  electronMock.showOpenDialog.mockReset();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/* ------------------------------------------------------------------ *
 * Path validation
 * ------------------------------------------------------------------ */

function discovered(overrides: Partial<DiscoveredGame> = {}): DiscoveredGame {
  return {
    id: 'steam:1',
    name: 'Test Game',
    source: 'steam',
    appId: '1',
    installDir: 'D:\\SteamLibrary\\steamapps\\common\\Test Game',
    executables: [
      {
        name: 'TestGame.exe',
        path: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\bin\\TestGame.exe',
      },
    ],
    executablePath: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\bin\\TestGame.exe',
    packageFamilyName: null,
    profileIds: [],
    ...overrides,
  };
}

describe('game path validation', () => {
  it('accepts drive-absolute paths and normalises separators', () => {
    expect(normaliseGamePath('D:\\SteamLibrary\\Test Game\\')).toBe('D:\\SteamLibrary\\Test Game');
    expect(normaliseGamePath('D:/SteamLibrary/Test Game')).toBe('D:\\SteamLibrary\\Test Game');
    expect(normaliseGamePath('C:\\')).toBe('C:\\');
  });

  it('rejects relative, traversal, UNC, device and stream paths', () => {
    expect(normaliseGamePath('Games\\Test')).toBeNull();
    expect(normaliseGamePath('D:\\Games\\..\\Windows')).toBeNull();
    expect(normaliseGamePath('D:\\Games\\.\\Test')).toBeNull();
    expect(normaliseGamePath('\\\\server\\share\\game')).toBeNull();
    expect(normaliseGamePath('\\\\?\\D:\\Games')).toBeNull();
    expect(normaliseGamePath('D:\\Games\\save:stream')).toBeNull();
    expect(normaliseGamePath('D:GAMES')).toBeNull();
    expect(normaliseGamePath(42)).toBeNull();
  });

  it('compares paths case-insensitively and keeps sibling prefixes distinct', () => {
    expect(gamePathKey('D:\\Games\\Test')).toBe(gamePathKey('d:/games/test/'));
    expect(isInsideGameFolder('D:\\Games\\Test', 'D:\\Games\\Test\\bin\\game.exe')).toBe(true);
    expect(isInsideGameFolder('D:\\Games\\Test', 'D:\\Games\\Test')).toBe(false);
    expect(isInsideGameFolder('D:\\Games\\Test', 'D:\\Games\\Test2\\game.exe')).toBe(false);
    expect(isInsideGameFolder('D:\\Games\\Test', 'D:\\Games\\Other\\game.exe')).toBe(false);
  });

  it('only resolves folders that a library scan discovered', () => {
    const game = discovered();
    expect(resolveGameFolder('d:/steamlibrary/steamapps/common/test game', [game])).toBe(game);

    expect(() => resolveGameFolder('C:\\Windows', [game])).toThrowError(/not an installed game directory/i);
    expect(() => resolveGameFolder('D:\\SteamLibrary\\..\\Windows', [game])).toThrowError(
      /absolute paths/i,
    );
    expect(() => resolveGameFolder('relative\\folder', [game])).toThrowError(/absolute paths/i);
  });

  it('launches only a detected executable inside the install root', () => {
    const game = discovered();
    expect(resolveLaunchExecutable(game)).toBe(game.executablePath);

    const outside = discovered({
      executablePath: 'D:\\SteamLibrary\\steamapps\\common\\Other Game\\Game.exe',
      executables: [{ name: 'Game.exe', path: 'D:\\SteamLibrary\\steamapps\\common\\Other Game\\Game.exe' }],
    });
    expect(() => resolveLaunchExecutable(outside)).toThrowError(/outside the game install folder/i);

    const notDetected = discovered({
      executablePath: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\bin\\Other.exe',
      executables: [
        { name: 'TestGame.exe', path: 'D:\\SteamLibrary\\steamapps\\common\\Test Game\\bin\\TestGame.exe' },
      ],
    });
    expect(() => resolveLaunchExecutable(notDetected)).toThrowError(/candidates discovered/i);
  });

  it('refuses a launch when no executable was detected', () => {
    const packageOnly = discovered({
      packageFamilyName: 'Microsoft.Game_8wekyb3d8bbwe',
      executablePath: null,
      executables: [],
    });
    expect(() => resolveLaunchExecutable(packageOnly)).toThrowError(/Microsoft Store titles/i);

    const empty = discovered({ executablePath: null, executables: [] });
    expect(() => resolveLaunchExecutable(empty)).toThrowError(/No executable was detected/i);
  });
});

/* ------------------------------------------------------------------ *
 * SteamGridDB metadata and cache
 * ------------------------------------------------------------------ */

describe('SteamGridDB metadata parsing', () => {
  it('validates search results and ignores unknown fields', () => {
    expect(
      parseSteamGridDbSearch({
        success: true,
        data: [{ id: 42, name: 'Test Game', verified: true }],
      }),
    ).toEqual([{ id: 42, name: 'Test Game' }]);
  });

  it('rejects malformed or failed envelopes', () => {
    expect(() => parseSteamGridDbSearch({ success: true, data: [{ id: '42', name: 'Bad' }] })).toThrowError(
      /malformed search results/i,
    );
    expect(() => parseSteamGridDbSearch({ success: false, errors: ['nope'] })).toThrowError(
      /could not complete/i,
    );
    expect(() => parseSteamGridDbImages({ success: true, data: [{ url: 42 }] })).toThrowError(
      /malformed artwork metadata/i,
    );
  });

  it('parses image metadata with dimensions and defaults', () => {
    expect(
      parseSteamGridDbImages({
        success: true,
        data: [
          {
            id: 1,
            url: 'https://cdn2.steamgriddb.com/grid/1.png',
            width: 600,
            height: 900,
            mime: 'image/png',
            style: 'static',
            nsfw: false,
            humor: false,
          },
          { url: 'https://cdn2.steamgriddb.com/grid/2.png' },
        ],
      }),
    ).toEqual([
      {
        url: 'https://cdn2.steamgriddb.com/grid/1.png',
        width: 600,
        height: 900,
        mime: 'image/png',
        style: 'static',
        nsfw: false,
        humor: false,
      },
      { url: 'https://cdn2.steamgriddb.com/grid/2.png', width: 0, height: 0 },
    ]);
  });

  it('matches titles exactly first, then by containment, and never guesses', () => {
    const entries = [
      { id: 1, name: 'Cyberpunk 2077' },
      { id: 2, name: 'Cyberpunk 2077: Phantom Liberty' },
      { id: 3, name: 'Unrelated Game' },
    ];
    expect(pickSearchEntry(entries, 'Cyberpunk 2077')?.id).toBe(1);
    expect(pickSearchEntry(entries, 'Cyberpunk 2077™')?.id).toBe(1);
    expect(pickSearchEntry(entries, 'Phantom Liberty')?.id).toBe(2);
    expect(pickSearchEntry(entries, 'A Completely Different Title')).toBeNull();
    expect(normaliseArtworkTitle('Tom Clancy’s Rainbow Six® Siege')).toBe(
      'tom clancy s rainbow six siege',
    );
  });

  it('prefers usable vertical grids and excludes NSFW, animated and non-SteamGridDB URLs', () => {
    const images = [
      { url: 'https://cdn2.steamgriddb.com/grid/wide.png', width: 920, height: 430, mime: 'image/png' },
      { url: 'https://cdn2.steamgriddb.com/grid/cover.png', width: 600, height: 900, mime: 'image/png' },
      { url: 'http://cdn2.steamgriddb.com/grid/http.png', width: 600, height: 900 },
      { url: 'https://cdn2.steamgriddb.com/grid/nsfw.png', width: 600, height: 900, nsfw: true },
      { url: 'https://cdn2.steamgriddb.com/grid/anim.webp', width: 600, height: 900, style: 'animated' },
    ];

    expect(pickArtworkImage(images, 'grid')?.url).toContain('/cover.png');
    expect(pickArtworkImage(images, 'hero')?.url).toContain('/wide.png');
    expect(pickArtworkImage([], 'logo')).toBeNull();
  });
});

describe('artwork cache URLs and image types', () => {
  const file = `${'a'.repeat(64)}.png`;
  const cacheDir = path.join(os.tmpdir(), 'tunesmith-artwork-protocol');

  it('maps only well-formed ts-art URLs into the cache images directory', () => {
    expect(artworkUrl(file)).toBe(`ts-art://artwork/${file}`);
    expect(resolveArtworkRequestPath(cacheDir, `ts-art://artwork/${file}`)).toBe(
      path.join(cacheDir, 'images', file),
    );

    expect(resolveArtworkRequestPath(cacheDir, `ts-art://other/${file}`)).toBeNull();
    expect(resolveArtworkRequestPath(cacheDir, `https://artwork/${file}`)).toBeNull();
    expect(resolveArtworkRequestPath(cacheDir, 'ts-art://artwork/..%2Fevil.png')).toBeNull();
    expect(resolveArtworkRequestPath(cacheDir, `ts-art://artwork/${'A'.repeat(64)}.png`)).toBeNull();
    expect(resolveArtworkRequestPath(cacheDir, `ts-art://artwork/${file}?download=1`)).not.toBeNull();
    expect(() => artworkUrl('..\\evil.png')).toThrowError(/Invalid cached artwork/i);
  });

  it('allows only https SteamGridDB hosts', () => {
    expect(isAllowedArtworkUrl('https://cdn2.steamgriddb.com/grid/1.png')).toBe(true);
    expect(isAllowedArtworkUrl('https://steamgriddb.com/grid/1.png')).toBe(true);
    expect(isAllowedArtworkUrl('http://cdn2.steamgriddb.com/grid/1.png')).toBe(false);
    expect(isAllowedArtworkUrl('https://evil.example/grid/1.png')).toBe(false);
    expect(isAllowedArtworkUrl('https://steamgriddb.com.evil.example/1.png')).toBe(false);
    expect(isAllowedArtworkUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
  });

  it('sniffs PNG, JPEG and WebP magic bytes and rejects anything else', () => {
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(
      detectImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe('webp');
    expect(detectImageType(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull();
  });
});

describe('SteamGridDbService', () => {
  const searchResponse = {
    success: true,
    data: [{ id: 42, name: 'Test Game' }],
  };

  function gridResponse(url: string): unknown {
    return {
      success: true,
      data: [
        { id: 1, url, width: 600, height: 900, mime: 'image/png', style: 'static', nsfw: false, humor: false },
      ],
    };
  }

  function heroResponse(url: string): unknown {
    return {
      success: true,
      data: [{ id: 2, url, width: 1920, height: 620, mime: 'image/png', style: 'static' }],
    };
  }

  function logoResponse(url: string): unknown {
    return {
      success: true,
      data: [{ id: 3, url, width: 600, height: 180, mime: 'image/png', style: 'static' }],
    };
  }

  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('returns a setup state without making any request when no key is configured', async () => {
    const cacheDir = path.join(await tempDir(), 'artwork-cache');
    const fetchImpl = vi.fn<FetchLike>();
    const service = new SteamGridDbService({ cacheDir, apiKey: null, fetchImpl });

    const batch = await service.artworkForGames([{ key: 'steam:1', title: 'Test Game' }]);
    expect(batch.configured).toBe(false);
    expect(batch.items[0]).toMatchObject({ key: 'steam:1', status: 'not-configured' });
    expect(batch.message).toMatch(/STEAMGRIDDB_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('searches, caches and serves local ts-art assets across service restarts', async () => {
    const cacheDir = path.join(await tempDir(), 'artwork-cache');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/search/autocomplete/')) return jsonResponse(searchResponse);
      if (url.includes('/grids/game/42')) {
        return jsonResponse(gridResponse('https://cdn2.steamgriddb.com/grid/42.png'));
      }
      if (url.includes('/heroes/game/42')) {
        return jsonResponse(heroResponse('https://cdn2.steamgriddb.com/hero/42.png'));
      }
      if (url.includes('/logos/game/42')) {
        return jsonResponse(logoResponse('https://cdn2.steamgriddb.com/logo/42.png'));
      }
      if (url.startsWith('https://cdn2.steamgriddb.com/')) {
        return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const service = new SteamGridDbService({ cacheDir, apiKey: 'a'.repeat(32), fetchImpl });
    const batch = await service.artworkForGames([{ key: 'steam:42', title: 'Test Game' }]);
    const art = batch.items[0];

    expect(batch.configured).toBe(true);
    expect(art?.status).toBe('ok');
    expect(art?.steamGridDbId).toBe(42);
    expect(art?.grid?.url).toMatch(/^ts-art:\/\/artwork\/[a-f0-9]{64}\.png$/);
    expect(art?.hero).not.toBeNull();
    expect(art?.logo).not.toBeNull();

    const fileName = art?.grid?.url.replace('ts-art://artwork/', '') ?? '';
    const bytes = await readFile(path.join(cacheDir, 'images', fileName));
    expect(detectImageType(bytes)).toBe('png');
    expect(calls.some((url) => url.includes('Authorization'))).toBe(false);

    // A second service reading the same directory must answer from disk, without network.
    calls.length = 0;
    const offline = new SteamGridDbService({
      cacheDir,
      apiKey: 'a'.repeat(32),
      fetchImpl: async () => {
        throw new Error('network should not be used for a cached title');
      },
    });
    const cached = await offline.artworkForGames([{ key: 'steam:42', title: 'Test Game' }]);
    expect(cached.items[0]?.status).toBe('ok');
    expect(cached.items[0]?.grid?.url).toBe(art?.grid?.url);
    expect(calls).toEqual([]);
  });

  it('reports an outage as a per-title error and retries on the next call', async () => {
    const cacheDir = path.join(await tempDir(), 'artwork-cache');
    let online = false;
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (!online) throw new Error('offline');
      // A successful search with no match is enough to prove the failure was not cached.
      return jsonResponse({ success: true, data: [] });
    };

    const service = new SteamGridDbService({ cacheDir, apiKey: 'b'.repeat(32), fetchImpl });
    const failed = await service.artworkForGames([{ key: 'steam:1', title: 'Test Game' }]);
    expect(failed.items[0]?.status).toBe('error');
    expect(failed.items[0]?.message).toMatch(/offline/i);

    online = true;
    const retried = await service.artworkForGames([{ key: 'steam:1', title: 'Test Game' }]);
    expect(retried.items[0]?.status).not.toBe('error');
    expect(attempts).toBeGreaterThan(1);
  });

  it('reads the key from the environment first, then the user-data file', async () => {
    const userData = await tempDir();
    const key = 'c'.repeat(32);
    await mkdir(userData, { recursive: true });
    await writeFile(path.join(userData, STEAMGRIDDB_KEY_FILE), `${key}\n`, 'utf8');

    expect(loadSteamGridDbApiKey(userData, {})).toBe(key);
    expect(loadSteamGridDbApiKey(userData, { STEAMGRIDDB_API_KEY: 'd'.repeat(32) })).toBe('d'.repeat(32));
    expect(loadSteamGridDbApiKey(userData, { STEAMGRIDDB_API_KEY: 'not a valid key' })).toBe(key);
  });
});

/* ------------------------------------------------------------------ *
 * IPC routing
 * ------------------------------------------------------------------ */

const STATUS: GameStatus = {
  watching: false,
  cryoFreeze: false,
  interruptAffinity: false,
  phase: 'idle',
  watcherHealthy: false,
  active: null,
  pendingRestore: null,
  lastError: null,
  topology: null,
  packages: [],
  telemetry: null,
  guard: null,
  profiles: 0,
  pollMs: 2000,
};

const SHADER_CACHE_STATUS: ShaderCacheStatus = {
  schemaVersion: 1,
  scannedAt: '2026-01-01T00:00:00.000Z',
  roots: [],
  totals: { fileCount: 0, totalBytes: 0, orphanedFiles: 0, orphanedBytes: 0 },
  warnings: [],
  error: null,
};

const TRUSTED_EVENT = { senderFrame: { url: 'file:///C:/Program%20Files/TuneSmith/index.html' } };
const UNTRUSTED_EVENT = { senderFrame: { url: 'https://evil.example/' } };

function makeState(
  scan: GameLibraryScanResult,
  artworkForGames: (items: ArtworkRequestItem[]) => Promise<GameArtworkBatch>,
): AppState {
  return {
    game: {
      setOnChange: vi.fn(),
      setWatching: vi.fn(async (enabled: boolean) => ({ ...STATUS, watching: enabled })),
      setCryoFreeze: vi.fn(async (enabled: boolean) => ({ ...STATUS, cryoFreeze: enabled })),
      setInterruptAffinity: vi.fn(async (enabled: boolean) => ({ ...STATUS, interruptAffinity: enabled })),
      refreshGameCandidates: vi.fn(async () => undefined),
      hasActiveSession: vi.fn(() => false),
      profileList: vi.fn(() => []),
      evaluate: vi.fn(() => []),
      status: vi.fn(() => STATUS),
      stopActive: vi.fn(async () => STATUS),
    },
    health: {
      onStatus: vi.fn(),
      check: vi.fn(async () => ({})),
    },
    shaderCache: {
      status: vi.fn(async () => SHADER_CACHE_STATUS),
      scan: vi.fn(async () => SHADER_CACHE_STATUS),
      prune: vi.fn(async (): Promise<ShaderCachePruneResult> => ({
        ok: true,
        removedFiles: 0,
        removedBytes: 0,
        skippedFiles: 0,
        warnings: [],
        message: 'No orphaned DirectX cache files were old enough to prune.',
        status: SHADER_CACHE_STATUS,
      })),
    },
    postApply: {
      setOnStatus: vi.fn(),
      status: vi.fn(() => idlePostApplyStatus()),
      reset: vi.fn(() => idlePostApplyStatus()),
    },
    libraries: {
      scan: vi.fn(async () => scan),
      addManualGame: vi.fn(async () => null),
      removeManualGame: vi.fn(async () => false),
    },
    artwork: {
      artworkForGames: vi.fn(artworkForGames),
    },
    artworkResolver: {
      resolve: vi.fn(async (appId: string | number) => ({
        appId: typeof appId === 'number' ? appId : Number(appId),
        cover: null,
        hero: null,
        header: null,
        logo: null,
        source: 'placeholder' as const,
        placeholder: true,
        message: null,
      })),
    },
  } as unknown as AppState;
}

async function callIpc(
  channel: string,
  payload: unknown,
  event: unknown = TRUSTED_EVENT,
): Promise<IpcEnvelope<unknown>> {
  const handler = electronMock.handlers.get(channel);
  if (handler === undefined) throw new Error(`No IPC handler registered for ${channel}`);
  return (await handler(event, payload)) as IpcEnvelope<unknown>;
}

async function installedFixture(): Promise<{
  game: DiscoveredGame;
  installDir: string;
  executable: string;
}> {
  const installDir = await tempDir();
  const executable = path.join(installDir, 'TestGame.exe');
  await writeFile(executable, '');
  return {
    installDir,
    executable,
    game: discovered({
      id: 'steam:local',
      name: 'Local Fixture',
      installDir,
      executables: [{ name: 'TestGame.exe', path: executable }],
      executablePath: executable,
    }),
  };
}

describe('launcher IPC routing', () => {
  it('exposes updater status and the required install-update channel', async () => {
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    const status: UpdaterStatus = {
      schemaVersion: 1,
      phase: 'downloaded',
      currentVersion: '0.1.0-test',
      availableVersion: '0.2.0',
      percent: 100,
      bytesPerSecond: null,
      message: 'Update 0.2.0 is ready to install.',
      checkedAt: '2026-01-01T00:00:00.000Z',
      isPackaged: true,
    };
    const updater = {
      status: vi.fn(() => status),
      check: vi.fn(async () => status),
      install: vi.fn(async () => undefined),
    } as unknown as UpdaterService;
    registerIpcHandlers(state, () => null, undefined, updater);

    expect(electronMock.handlers.has('tunesmith:install-update')).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.updateStatus)).toBe(true);

    const current = await callIpc(IPC_CHANNELS.updateStatus, undefined);
    expect(current.ok).toBe(true);
    if (current.ok) expect((current.value as UpdaterStatus).phase).toBe('downloaded');

    const checked = await callIpc(IPC_CHANNELS.updateCheck, undefined);
    expect(checked.ok).toBe(true);
    expect(updater.check).toHaveBeenCalledOnce();

    state.game.hasActiveSession = vi.fn(() => true);
    const blocked = await callIpc('tunesmith:install-update', undefined);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toMatch(/active game session/i);
    expect(updater.install).not.toHaveBeenCalled();

    state.game.hasActiveSession = vi.fn(() => false);
    const installed = await callIpc('tunesmith:install-update', undefined);
    expect(installed.ok).toBe(true);
    expect(updater.install).toHaveBeenCalledOnce();
  });

  it('routes the Cryo-Freeze setting and rejects ambiguous payloads', async () => {
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    registerIpcHandlers(state, () => null);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameSetCryoFreeze)).toBe(true);

    const enabled = await callIpc(IPC_CHANNELS.gameSetCryoFreeze, { enabled: true });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect((enabled.value as GameStatus).cryoFreeze).toBe(true);
    expect(state.game.setCryoFreeze).toHaveBeenCalledWith(true);

    const invalid = await callIpc(IPC_CHANNELS.gameSetCryoFreeze, { enabled: 'yes' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-request');
    expect(state.game.setCryoFreeze).toHaveBeenCalledTimes(1);
  });

  it('routes the interrupt-affinity setting and rejects ambiguous payloads', async () => {
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    registerIpcHandlers(state, () => null);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameSetInterruptAffinity)).toBe(true);

    const enabled = await callIpc(IPC_CHANNELS.gameSetInterruptAffinity, { enabled: true });
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect((enabled.value as GameStatus).interruptAffinity).toBe(true);
    expect(state.game.setInterruptAffinity).toHaveBeenCalledWith(true);

    const invalid = await callIpc(IPC_CHANNELS.gameSetInterruptAffinity, { enabled: 'yes' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-request');
    expect(state.game.setInterruptAffinity).toHaveBeenCalledTimes(1);
  });

  it('routes shader-cache scans and requires explicit orphan-prune confirmation', async () => {
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    registerIpcHandlers(state, () => null);
    expect(electronMock.handlers.has(IPC_CHANNELS.shaderCacheStatus)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.shaderCacheScan)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.shaderCachePrune)).toBe(true);

    const scan = await callIpc(IPC_CHANNELS.shaderCacheScan, { refresh: true });
    expect(scan.ok).toBe(true);
    expect(state.shaderCache.scan).toHaveBeenCalledWith(true);

    const unconfirmed = await callIpc(IPC_CHANNELS.shaderCachePrune, { cacheIds: ['directx'] });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) expect(unconfirmed.error.code).toBe('invalid-request');
    expect(state.shaderCache.prune).not.toHaveBeenCalled();

    const vendor = await callIpc(IPC_CHANNELS.shaderCachePrune, {
      cacheIds: ['nvidia-dx'],
      confirm: true,
    });
    expect(vendor.ok).toBe(false);
    expect(state.shaderCache.prune).not.toHaveBeenCalled();

    state.game.hasActiveSession = vi.fn(() => true);
    const active = await callIpc(IPC_CHANNELS.shaderCachePrune, {
      cacheIds: ['directx'],
      confirm: true,
    });
    expect(active.ok).toBe(false);
    if (!active.ok) expect(active.error.message).toMatch(/active game session/i);
    expect(state.shaderCache.prune).not.toHaveBeenCalled();

    state.game.hasActiveSession = vi.fn(() => false);
    const pruned = await callIpc(IPC_CHANNELS.shaderCachePrune, {
      cacheIds: ['directx'],
      confirm: true,
    });
    expect(pruned.ok).toBe(true);
    expect(state.shaderCache.prune).toHaveBeenCalledWith(['directx']);
  });

  it('registers the artwork, folder and launch channels and validates their payloads', async () => {
    const artworkForGames = vi.fn(async (items: ArtworkRequestItem[]) => ({
      configured: true,
      message: null,
      items: items.map((item) => ({
        key: item.key,
        title: item.title,
        status: 'not-found' as const,
        steamGridDbId: null,
        matchedTitle: null,
        grid: null,
        hero: null,
        logo: null,
        message: 'fixture',
      })),
    }));
    const state = makeState({ scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] }, artworkForGames);
    registerIpcHandlers(state, () => null);

    expect(electronMock.handlers.has(IPC_CHANNELS.gameArtwork)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameResolveArtwork)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameOpenFolder)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameLaunch)).toBe(true);

    const resolved = await callIpc(IPC_CHANNELS.gameResolveArtwork, { appId: '730' });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect((resolved.value as { appId: number | null }).appId).toBe(730);
    expect(state.artworkResolver.resolve).toHaveBeenCalledWith('730');

    const badAppId = await callIpc(IPC_CHANNELS.gameResolveArtwork, { appId: '../730' });
    expect(badAppId.ok).toBe(false);
    if (!badAppId.ok) expect(badAppId.error.code).toBe('invalid-request');

    const valid = await callIpc(IPC_CHANNELS.gameArtwork, {
      games: [{ key: 'steam:1', title: 'Test Game' }],
    });
    expect(valid.ok).toBe(true);
    expect(artworkForGames).toHaveBeenCalledWith([{ key: 'steam:1', title: 'Test Game' }]);

    const invalid = await callIpc(IPC_CHANNELS.gameArtwork, {
      games: [{ key: 'steam:1', title: '' }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('invalid-request');
    expect(artworkForGames).toHaveBeenCalledTimes(1);
  });

  it('routes manual game additions and removals, validating every payload', async () => {
    const fixture = await installedFixture();
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [fixture.game], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    const libraries = state.libraries as unknown as {
      addManualGame: ReturnType<typeof vi.fn>;
      removeManualGame: ReturnType<typeof vi.fn>;
    };
    libraries.addManualGame.mockResolvedValue(fixture.game);
    libraries.removeManualGame.mockResolvedValue(true);
    registerIpcHandlers(state, () => null);

    expect(electronMock.handlers.has(IPC_CHANNELS.gameAddManual)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.gameRemoveManual)).toBe(true);
    expect(electronMock.handlers.has(IPC_CHANNELS.gamePickPath)).toBe(true);

    const rawPathAdd = await callIpc(IPC_CHANNELS.gameAddManual, {
      name: 'Local Fixture',
      installDir: fixture.installDir,
      executablePath: fixture.executable,
    });
    expect(rawPathAdd.ok).toBe(false);
    if (!rawPathAdd.ok) expect(rawPathAdd.error.code).toBe('invalid-request');
    expect(libraries.addManualGame).not.toHaveBeenCalled();

    const unknownTokens = await callIpc(IPC_CHANNELS.gameAddManual, {
      name: 'Local Fixture',
      installDirToken: '0'.repeat(36),
      executableToken: '1'.repeat(36),
    });
    expect(unknownTokens.ok).toBe(false);
    if (!unknownTokens.ok) expect(unknownTokens.error.code).toBe('invalid-request');
    expect(libraries.addManualGame).not.toHaveBeenCalled();

    libraries.addManualGame.mockResolvedValue(fixture.game);
    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [fixture.installDir] });
    const folderPick = await callIpc(IPC_CHANNELS.gamePickPath, { kind: 'folder' });
    expect(folderPick.ok).toBe(true);
    if (!folderPick.ok) throw new Error('folder picker was rejected');
    const folder = folderPick.value as { token: string; path: string; kind: string };
    expect(folder.path).toBe(fixture.installDir);
    expect(folder.kind).toBe('folder');

    electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [fixture.executable] });
    const executablePick = await callIpc(IPC_CHANNELS.gamePickPath, { kind: 'executable' });
    expect(executablePick.ok).toBe(true);
    if (!executablePick.ok) throw new Error('executable picker was rejected');
    const executable = executablePick.value as { token: string; path: string; kind: string };
    expect(executable.path).toBe(fixture.executable);
    expect(executable.kind).toBe('executable');

    const added = await callIpc(IPC_CHANNELS.gameAddManual, {
      name: 'Local Fixture',
      installDirToken: folder.token,
      executableToken: executable.token,
    });
    expect(added.ok).toBe(true);
    expect(libraries.addManualGame).toHaveBeenCalledWith({
      name: 'Local Fixture',
      installDir: fixture.installDir,
      executablePath: fixture.executable,
    });

    const removed = await callIpc(IPC_CHANNELS.gameRemoveManual, { gameId: fixture.game.id });
    expect(removed.ok).toBe(true);
    expect(libraries.removeManualGame).toHaveBeenCalledWith(fixture.game.id);

    const invalidRemove = await callIpc(IPC_CHANNELS.gameRemoveManual, { gameId: '../bad' });
    expect(invalidRemove.ok).toBe(false);
    if (!invalidRemove.ok) expect(invalidRemove.error.code).toBe('invalid-request');
    expect(libraries.removeManualGame).toHaveBeenCalledTimes(1);

    const invalidPick = await callIpc(IPC_CHANNELS.gamePickPath, { kind: 'drive' });
    expect(invalidPick.ok).toBe(false);
    if (!invalidPick.ok) expect(invalidPick.error.code).toBe('invalid-request');
  });

  it('rejects untrusted senders before touching a service', async () => {
    const artworkForGames = vi.fn(async (items: ArtworkRequestItem[]) => ({
      configured: true,
      message: null,
      items: [],
    }));
    const state = makeState({ scannedAt: '2026-01-01T00:00:00.000Z', games: [], errors: [] }, artworkForGames);
    registerIpcHandlers(state, () => null);

    const response = await callIpc(
      IPC_CHANNELS.gameArtwork,
      { games: [{ key: 'steam:1', title: 'Test Game' }] },
      UNTRUSTED_EVENT,
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('invalid-request');
    expect(artworkForGames).not.toHaveBeenCalled();
  });

  it('opens only a detected install folder, case-insensitively, and never a traversed path', async () => {
    const fixture = await installedFixture();
    const scan: GameLibraryScanResult = {
      scannedAt: '2026-01-01T00:00:00.000Z',
      games: [fixture.game],
      errors: [],
    };
    const state = makeState(scan, async () => ({ configured: false, message: null, items: [] }));
    registerIpcHandlers(state, () => null);

    const opened = await callIpc(IPC_CHANNELS.gameOpenFolder, { path: fixture.installDir.toUpperCase() });
    expect(opened.ok).toBe(true);
    expect(electronMock.openPath).toHaveBeenCalledWith(fixture.installDir);

    electronMock.openPath.mockClear();
    const traversal = await callIpc(IPC_CHANNELS.gameOpenFolder, {
      path: `${fixture.installDir}\\..\\..\\Windows`,
    });
    expect(traversal.ok).toBe(false);
    expect(electronMock.openPath).not.toHaveBeenCalled();

    const unknown = await callIpc(IPC_CHANNELS.gameOpenFolder, { path: await tempDir() });
    expect(unknown.ok).toBe(false);
    expect(electronMock.openPath).not.toHaveBeenCalled();
  });

  it('launches a detected executable and arms the watcher before opening it', async () => {
    const fixture = await installedFixture();
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [fixture.game], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    registerIpcHandlers(state, () => null);

    const response = await callIpc(IPC_CHANNELS.gameLaunch, { gameId: fixture.game.id });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('launch failed');

    const result = response.value as GameLaunchResult;
    expect(result.launched).toBe(true);
    expect(result.watching).toBe(true);
    expect(result.executablePath).toBe(fixture.executable);
    expect(state.game.setWatching).toHaveBeenCalledWith(true);
    expect(electronMock.openPath).toHaveBeenCalledWith(fixture.executable);
    expect(electronMock.openPath.mock.invocationCallOrder[0]).toBeGreaterThan(
      (state.game.setWatching as unknown as { mock: { invocationCallOrder: number[] } }).mock
        .invocationCallOrder[0] ?? 0,
    );
  });

  it('refuses a launch when the title has no detected executable, without arming the watcher', async () => {
    const installDir = await tempDir();
    const packageOnly = discovered({
      id: 'xbox:fixture',
      source: 'xbox',
      packageFamilyName: 'Microsoft.Fixture_8wekyb3d8bbwe',
      installDir,
      executables: [],
      executablePath: null,
    });
    const state = makeState(
      { scannedAt: '2026-01-01T00:00:00.000Z', games: [packageOnly], errors: [] },
      async () => ({ configured: false, message: null, items: [] }),
    );
    registerIpcHandlers(state, () => null);

    const response = await callIpc(IPC_CHANNELS.gameLaunch, { gameId: packageOnly.id });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe('unavailable');
    expect(state.game.setWatching).not.toHaveBeenCalled();
    expect(electronMock.openPath).not.toHaveBeenCalled();
  });
});
