/**
 * Read-only game library discovery.
 *
 * Scans the local launchers' own metadata (Steam VDF/ACF, Epic JSON, Microsoft Store
 * package manifests, GOG registry entries) and maps installed titles to their executable
 * paths. It never writes, launches, or trusts a manifest path blindly:
 *
 *   - every read is bounded (file size, entry count, recursion depth);
 *   - manifest paths are resolved and checked to stay inside the declared install root;
 *   - only bare `.exe` image names become executable candidates;
 *   - a failed source is reported as a warning and never prevents the other sources.
 *
 * Profile matching is a separate pure module (`shared/game/library.ts`); this file only
 * reports what is installed.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describeError, TuneSmithError } from '../../../shared/errors';
import type {
  DiscoveredExecutable,
  DiscoveredGame,
  GameLibraryScanResult,
  GameLibrarySource,
  ManualGameInput,
} from '../../../shared/game/types';
import type { ManualGameStore } from './manual-games';
import { asArray, runPowerShellJson } from '../powershell';
import { readValue } from '../registry';

const LIMITS = {
  maxManifestBytes: 2 * 1024 * 1024,
  maxManifests: 500,
  maxScanEntries: 800,
  maxExecutables: 8,
  maxGames: 250,
  maxDepth: 3,
} as const;

const EXE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,95}\.exe$/i;
const HELPER_RE = /(^unins|^setup|^install|^crash|^report|^dxsetup|^vcredist|^dotnet|^eac|^easyanticheat|^battleye|^steam_api|service$)/i;
const LAUNCHER_RE = /(launcher|bootstrap|client|updater)/i;
const ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

export interface GameLibraryOptions {
  /** Explicit Steam roots. `undefined` uses the standard locations + HKCU SteamPath. */
  steamRoots?: readonly string[];
  /** Explicit Epic manifest directories. `undefined` uses `%ProgramData%`. */
  epicManifestDirs?: readonly string[];
  includeXbox?: boolean;
  includeGog?: boolean;
  /** Persistent user-added entries merged into every scan. */
  manualGames?: ManualGameStore;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/* ------------------------------------------------------------------ *
 * Valve KeyValues (the subset used by Steam manifests)
 * ------------------------------------------------------------------ */

export interface VdfObject {
  [key: string]: string | VdfObject;
}

interface Cursor {
  at: number;
}

function tokenizeVdf(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < source.length) {
    const char = source[index] ?? '';

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === '{' || char === '}') {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let value = '';
      while (index < source.length) {
        const current = source[index] ?? '';
        if (current === '\\') {
          const next = source[index + 1];
          if (next !== undefined) {
            value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
            index += 2;
            continue;
          }
        }
        if (current === '"') {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push(value);
      continue;
    }

    const start = index;
    while (index < source.length && !/[\s{}]/.test(source[index] ?? '')) index += 1;
    tokens.push(source.slice(start, index));
  }

  return tokens;
}

function parseVdfObject(tokens: readonly string[], cursor: Cursor): VdfObject {
  const object: VdfObject = {};

  while (cursor.at < tokens.length) {
    const key = tokens[cursor.at];
    cursor.at += 1;
    if (key === undefined || key === '}') break;
    if (key === '{') continue;

    const next = tokens[cursor.at];
    cursor.at += 1;
    if (next === undefined) break;
    if (next === '{') {
      object[key] = parseVdfObject(tokens, cursor);
    } else if (next !== '}') {
      object[key] = next;
    }
  }

  return object;
}

/** Parse a Valve KeyValues document. Export is for fixtures and tests. */
export function parseValveKeyValues(text: string): VdfObject {
  if (text.length > 4 * 1024 * 1024) throw new Error('VDF document is too large');
  const cursor: Cursor = { at: 0 };
  return parseVdfObject(tokenizeVdf(text), cursor);
}

function vdfGet(object: VdfObject, key: string): string | VdfObject | undefined {
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(object)) {
    if (name.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function vdfString(object: VdfObject, key: string): string | null {
  const value = vdfGet(object, key);
  return typeof value === 'string' ? value : null;
}

function asObject(value: string | VdfObject | undefined): VdfObject | null {
  return value !== undefined && typeof value === 'object' ? value : null;
}

/** Library roots from `libraryfolders.vdf`; includes legacy numeric entries. */
export function parseSteamLibraryFolders(text: string): string[] {
  const root = parseValveKeyValues(text);
  const libraryFolders = asObject(vdfGet(root, 'libraryfolders')) ?? root;
  const paths = new Set<string>();

  for (const value of Object.values(libraryFolders)) {
    const entry = asObject(value);
    if (entry === null) continue;
    const candidate = vdfString(entry, 'path');
    if (candidate !== null && candidate.trim().length > 0) paths.add(candidate.trim());
  }

  return [...paths];
}

export interface SteamManifest {
  appId: string | null;
  name: string;
  installDir: string;
}

export function parseSteamManifest(text: string): SteamManifest | null {
  const root = parseValveKeyValues(text);
  const appState = asObject(vdfGet(root, 'AppState')) ?? root;
  const name = vdfString(appState, 'name')?.trim() ?? '';
  const installDir = vdfString(appState, 'installdir')?.trim() ?? '';
  const appId = vdfString(appState, 'appid')?.trim() ?? null;

  if (name.length === 0 || installDir.length === 0) return null;
  if (installDir.includes('..') || path.isAbsolute(installDir)) return null;
  return { appId, name: name.slice(0, 160), installDir };
}

/* ------------------------------------------------------------------ *
 * Bounded executable discovery
 * ------------------------------------------------------------------ */

interface FoundExecutable {
  name: string;
  path: string;
  depth: number;
}

function normaliseToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function executableScore(executable: FoundExecutable, gameName: string): number {
  const base = executable.name.replace(/\.exe$/i, '');
  const token = normaliseToken(base);
  const game = normaliseToken(gameName);
  let score = 0;

  if (token === game) score += 120;
  else if (game.length > 0 && (game.includes(token) || token.includes(game))) score += 60;
  if (executable.depth === 0) score += 12;
  if (LAUNCHER_RE.test(base)) score -= 25;
  if (HELPER_RE.test(base)) score -= 150;
  return score;
}

async function collectExecutables(root: string): Promise<FoundExecutable[]> {
  const found: FoundExecutable[] = [];
  let entriesSeen = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > LIMITS.maxDepth || entriesSeen >= LIMITS.maxScanEntries) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entriesSeen >= LIMITS.maxScanEntries) return;
      entriesSeen += 1;
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (depth >= LIMITS.maxDepth) continue;
        if (/^(redist|_commonredist|support|docs?|tools?|directx|vcredist)$/i.test(entry.name)) continue;
        await walk(path.join(dir, entry.name), depth + 1);
        continue;
      }

      if (!entry.isFile() || !EXE_RE.test(entry.name)) continue;
      found.push({ name: entry.name, path: path.join(dir, entry.name), depth });
    }
  }

  await walk(root, 0);
  return found;
}

function rankExecutables(found: readonly FoundExecutable[], gameName: string): DiscoveredExecutable[] {
  return [...found]
    .sort(
      (a, b) =>
        executableScore(b, gameName) - executableScore(a, gameName) ||
        a.depth - b.depth ||
        a.name.localeCompare(b.name),
    )
    .slice(0, LIMITS.maxExecutables)
    .map((entry) => ({ name: entry.name, path: entry.path }));
}

/** Resolve a relative path inside an install root; null on traversal or absolute input. */
function safeChild(root: string, relative: string): string | null {
  if (relative.trim().length === 0 || path.isAbsolute(relative) || relative.includes('..')) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  if (resolved !== resolvedRoot && !resolved.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep}`)) {
    return null;
  }
  return resolved;
}

async function executablesFor(root: string, gameName: string, preferred: readonly string[] = []): Promise<DiscoveredExecutable[]> {
  const found = await collectExecutables(root);
  const byPath = new Map(found.map((entry) => [entry.path.toLowerCase(), entry]));
  for (const absolute of preferred) {
    const name = path.basename(absolute);
    if (!EXE_RE.test(name)) continue;
    const key = absolute.toLowerCase();
    if (!byPath.has(key)) byPath.set(key, { name, path: absolute, depth: 0 });
  }
  return rankExecutables([...byPath.values()], gameName);
}

async function readBounded(file: string): Promise<string | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.byteLength > LIMITS.maxManifestBytes) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const found = value[key];
  return typeof found === 'string' && found.trim().length > 0 ? found.trim() : null;
}

function absoluteDirectory(value: string | null): string | null {
  if (value === null || !ABSOLUTE_PATH_RE.test(value) || value.includes('..')) return null;
  return path.normalize(value);
}

function bareExe(value: string): string | null {
  const name = path.basename(value.replace(/\\/g, '/'));
  return EXE_RE.test(name) ? name : null;
}

/* ------------------------------------------------------------------ *
 * Steam
 * ------------------------------------------------------------------ */

async function defaultSteamRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles'] as const) {
    const base = process.env[key];
    if (base !== undefined && base.trim().length > 0) roots.add(path.join(base, 'Steam'));
  }
  roots.add('C:\\Program Files (x86)\\Steam');
  roots.add('C:\\Program Files\\Steam');

  try {
    const value = await readValue('HKCU', 'Software\\Valve\\Steam', 'SteamPath');
    if (value.exists && typeof value.data === 'string' && value.data.trim().length > 0) {
      roots.add(value.data.trim());
    }
  } catch {
    // reg.exe unavailable or the value is unreadable: standard paths are enough.
  }

  return [...roots];
}

export async function scanSteamLibraries(roots: readonly string[]): Promise<DiscoveredGame[]> {
  const games: DiscoveredGame[] = [];
  const libraries = new Set<string>();

  for (const root of roots) {
    if (!ABSOLUTE_PATH_RE.test(root)) continue;
    libraries.add(path.normalize(root));
    const libraryFile = path.join(root, 'steamapps', 'libraryfolders.vdf');
    const text = await readBounded(libraryFile);
    if (text === null) continue;
    try {
      for (const library of parseSteamLibraryFolders(text)) {
        if (ABSOLUTE_PATH_RE.test(library) && !library.includes('..')) libraries.add(path.normalize(library));
      }
    } catch {
      // A malformed library file only hides the extra libraries; the root is still usable.
    }
  }

  for (const library of libraries) {
    const steamApps = path.join(library, 'steamapps');
    let entries;
    try {
      entries = await readdir(steamApps, { withFileTypes: true });
    } catch {
      continue;
    }

    const manifests = entries
      .filter((entry) => entry.isFile() && /^appmanifest_\d+\.acf$/i.test(entry.name))
      .slice(0, LIMITS.maxManifests);

    for (const manifest of manifests) {
      const text = await readBounded(path.join(steamApps, manifest.name));
      if (text === null) continue;
      let parsed: SteamManifest | null;
      try {
        parsed = parseSteamManifest(text);
      } catch {
        continue;
      }
      if (parsed === null) continue;

      const installDir = path.join(steamApps, 'common', parsed.installDir);
      if (!path.isAbsolute(installDir)) continue;
      const executables = await executablesFor(installDir, parsed.name);
      games.push({
        id: `steam:${parsed.appId ?? (normaliseToken(parsed.name) || manifest.name)}`,
        name: parsed.name,
        source: 'steam',
        appId: parsed.appId,
        installDir,
        executables,
        executablePath: executables[0]?.path ?? null,
        packageFamilyName: null,
        profileIds: [],
      });
    }
  }

  return games;
}

/* ------------------------------------------------------------------ *
 * Epic Games Store
 * ------------------------------------------------------------------ */

function defaultEpicManifestDirs(): string[] {
  const programData = process.env.ProgramData ?? process.env.ALLUSERSPROFILE ?? 'C:\\ProgramData';
  return [path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')];
}

export interface EpicManifestFacts {
  appId: string | null;
  name: string;
  installDir: string;
  launchExecutable: string | null;
}

export function normaliseEpicManifest(raw: unknown): EpicManifestFacts | null {
  if (!isRecord(raw)) return null;
  const name = stringField(raw, 'DisplayName') ?? stringField(raw, 'AppName');
  const installDir = absoluteDirectory(stringField(raw, 'InstallLocation'));
  if (name === null || installDir === null) return null;
  const launch = stringField(raw, 'LaunchExecutable');
  return {
    appId: stringField(raw, 'AppName') ?? stringField(raw, 'CatalogItemId'),
    name: name.slice(0, 160),
    installDir,
    launchExecutable: launch,
  };
}

export async function scanEpicLibraries(dirs: readonly string[]): Promise<DiscoveredGame[]> {
  const games: DiscoveredGame[] = [];

  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const manifests = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.item'))
      .slice(0, LIMITS.maxManifests);

    for (const manifest of manifests) {
      const text = await readBounded(path.join(dir, manifest.name));
      if (text === null) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        continue;
      }
      const facts = normaliseEpicManifest(raw);
      if (facts === null) continue;

      const preferred: string[] = [];
      if (facts.launchExecutable !== null) {
        const candidate = safeChild(facts.installDir, facts.launchExecutable);
        if (candidate !== null) preferred.push(candidate);
      }
      const executables = await executablesFor(facts.installDir, facts.name, preferred);
      games.push({
        id: `epic:${facts.appId ?? (normaliseToken(facts.name) || manifest.name)}`,
        name: facts.name,
        source: 'epic',
        appId: facts.appId,
        installDir: facts.installDir,
        executables,
        executablePath: executables[0]?.path ?? null,
        packageFamilyName: null,
        profileIds: [],
      });
    }
  }

  return games;
}

/* ------------------------------------------------------------------ *
 * GOG
 * ------------------------------------------------------------------ */

export interface GogFacts {
  gameId: string | null;
  name: string;
  installDir: string;
  exe: string | null;
}

export function normaliseGogEntry(raw: unknown): GogFacts | null {
  if (!isRecord(raw)) return null;
  const installDir = absoluteDirectory(stringField(raw, 'path'));
  const name = stringField(raw, 'gameName') ?? (installDir === null ? null : path.basename(installDir));
  if (installDir === null || name === null) return null;
  return {
    gameId: stringField(raw, 'gameID'),
    name: name.slice(0, 160),
    installDir,
    exe: stringField(raw, 'exe'),
  };
}

export async function scanGogLibraries(): Promise<DiscoveredGame[]> {
  const raw = await runPowerShellJson<unknown>(
    String.raw`
$out = @()
foreach ($root in @('HKCU:\Software\GOG.com\Games','HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games','HKLM:\SOFTWARE\GOG.com\Games')) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($child in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty -LiteralPath $child.PSPath -ErrorAction SilentlyContinue
    if ($null -eq $props -or $null -eq $props.path) { continue }
    $out += [pscustomobject]@{
      gameName = [string]$props.gameName
      path     = [string]$props.path
      exe      = [string]$props.exe
      gameID   = [string]$props.gameID
    }
  }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
`,
    { timeoutMs: 15_000 },
  );

  const games: DiscoveredGame[] = [];
  for (const entry of asArray(raw)) {
    const facts = normaliseGogEntry(entry);
    if (facts === null) continue;
    const preferred: string[] = [];
    if (facts.exe !== null) {
      const candidate = path.isAbsolute(facts.exe)
        ? facts.exe
        : safeChild(facts.installDir, facts.exe);
      if (candidate !== null) preferred.push(candidate);
    }
    const executables = await executablesFor(facts.installDir, facts.name, preferred);
    games.push({
      id: `gog:${facts.gameId ?? normaliseToken(facts.name)}`,
      name: facts.name,
      source: 'gog',
      appId: facts.gameId,
      installDir: facts.installDir,
      executables,
      executablePath: executables[0]?.path ?? null,
      packageFamilyName: null,
      profileIds: [],
    });
  }
  return games;
}

/* ------------------------------------------------------------------ *
 * Microsoft Store / Xbox
 * ------------------------------------------------------------------ */

export interface XboxFacts {
  familyName: string;
  name: string;
  installDir: string;
  executables: string[];
}

export function normaliseXboxPackage(raw: unknown): XboxFacts | null {
  if (!isRecord(raw)) return null;
  const familyName = stringField(raw, 'familyName');
  const installDir = absoluteDirectory(stringField(raw, 'installLocation'));
  if (familyName === null || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(familyName) || installDir === null) {
    return null;
  }
  const name = stringField(raw, 'name') ?? familyName;
  const rawExecutables = Array.isArray(raw.executables) ? raw.executables : [raw.executables];
  const executables = rawExecutables
    .filter((value): value is string => typeof value === 'string')
    .map(bareExe)
    .filter((value): value is string => value !== null);
  return { familyName, name: name.slice(0, 160), installDir, executables: [...new Set(executables)] };
}

export async function scanXboxLibraries(): Promise<DiscoveredGame[]> {
  const raw = await runPowerShellJson<unknown>(
    String.raw`
$out = @()
foreach ($package in @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework -and $_.InstallLocation })) {
  $manifest = $null
  try { $manifest = Get-AppxPackageManifest -Package $package -ErrorAction SilentlyContinue } catch { }
  if ($null -eq $manifest) { continue }
  $executables = @()
  foreach ($application in @($manifest.Package.Applications.Application)) {
    if ($null -ne $application.Executable) { $executables += [string]$application.Executable }
  }
  if ($executables.Count -eq 0) { continue }
  $out += [pscustomobject]@{
    familyName      = [string]$package.PackageFamilyName
    name            = [string]$manifest.Package.Properties.DisplayName
    installLocation = [string]$package.InstallLocation
    executables     = @($executables)
  }
  if ($out.Count -ge 250) { break }
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
`,
    { timeoutMs: 30_000 },
  );

  const games: DiscoveredGame[] = [];
  for (const entry of asArray(raw)) {
    const facts = normaliseXboxPackage(entry);
    if (facts === null) continue;
    const preferred = facts.executables
      .map((name) => safeChild(facts.installDir, name))
      .filter((value): value is string => value !== null);
    const executables = await executablesFor(facts.installDir, facts.name, preferred);
    if (executables.length === 0) continue;
    games.push({
      id: `xbox:${facts.familyName.toLowerCase()}`,
      name: facts.name,
      source: 'xbox',
      appId: facts.familyName,
      installDir: facts.installDir,
      executables,
      executablePath: executables[0]?.path ?? null,
      packageFamilyName: facts.familyName,
      profileIds: [],
    });
  }
  return games;
}

/* ------------------------------------------------------------------ *
 * Orchestration and profile matching
 * ------------------------------------------------------------------ */

function errorMessage(error: unknown): string {
  return describeError(error).replace(/\s+/g, ' ').slice(0, 300);
}

function dedupe(games: readonly DiscoveredGame[]): DiscoveredGame[] {
  const seen = new Set<string>();
  const result: DiscoveredGame[] = [];
  for (const game of games) {
    const key = `${game.source}:${game.appId ?? game.installDir.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(game);
    if (result.length >= LIMITS.maxGames) break;
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export class GameLibraryService {
  private cache: { at: number; result: GameLibraryScanResult } | null = null;
  private inFlight: Promise<GameLibraryScanResult> | null = null;

  constructor(private readonly options: GameLibraryOptions = {}) {}

  async scan(force = false): Promise<GameLibraryScanResult> {
    if (!force && this.cache !== null && Date.now() - this.cache.at < 5 * 60 * 1000) {
      return this.cache.result;
    }
    // The profile list and the detected-library panel ask at the same time on startup.
    // Share one scan instead of launching duplicate PowerShell processes.
    if (this.inFlight !== null) return this.inFlight;

    const pending = this.runScan();
    this.inFlight = pending;
    try {
      const result = await pending;
      this.cache = { at: Date.now(), result };
      return result;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  /** Persist a local title that no launcher manifest exposed. */
  async addManualGame(input: ManualGameInput): Promise<DiscoveredGame> {
    if (this.options.manualGames === undefined) {
      throw new TuneSmithError('unavailable', 'Manual game entries are unavailable in this build.');
    }
    const game = await this.options.manualGames.add(input);
    await this.invalidate();
    return game;
  }

  async removeManualGame(gameId: string): Promise<boolean> {
    if (this.options.manualGames === undefined) return false;
    const removed = await this.options.manualGames.remove(gameId);
    if (removed) await this.invalidate();
    return removed;
  }

  private async invalidate(): Promise<void> {
    this.cache = null;
    const pending = this.inFlight;
    if (pending === null) return;
    try {
      await pending;
    } catch {
      // The next scan will report the source failure; invalidation only clears the cache.
    }
    this.cache = null;
  }

  private async runScan(): Promise<GameLibraryScanResult> {
    const errors: GameLibraryScanResult['errors'] = [];
    const manual =
      this.options.manualGames === undefined
        ? { games: [], errors: [] }
        : await this.options.manualGames.load();
    errors.push(...manual.errors);
    const sources: Promise<DiscoveredGame[]>[] = [];
    const labels: GameLibrarySource[] = [];

    let steamRoots = this.options.steamRoots;
    if (steamRoots === undefined) steamRoots = await defaultSteamRoots();
    sources.push(scanSteamLibraries(steamRoots));
    labels.push('steam');

    const epicDirs = this.options.epicManifestDirs ?? defaultEpicManifestDirs();
    sources.push(scanEpicLibraries(epicDirs));
    labels.push('epic');

    const includeXbox = this.options.includeXbox ?? process.platform === 'win32';
    if (includeXbox) {
      sources.push(scanXboxLibraries());
      labels.push('xbox');
    }

    const includeGog = this.options.includeGog ?? process.platform === 'win32';
    if (includeGog) {
      sources.push(scanGogLibraries());
      labels.push('gog');
    }

    const settled = await Promise.allSettled(sources);
    const games: DiscoveredGame[] = [...manual.games];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') games.push(...outcome.value);
      else errors.push({ source: labels[index] ?? 'library', message: errorMessage(outcome.reason) });
    }

    return {
      scannedAt: this.options.now?.() ?? new Date().toISOString(),
      games: dedupe(games),
      errors,
    };
  }
}
