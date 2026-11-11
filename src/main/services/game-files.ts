/**
 * Validation for the two privileged path operations the launcher needs: opening a game
 * folder and launching a detected executable.
 *
 * Neither operation trusts a renderer-supplied path. A requested folder must be exactly
 * one of the install directories the library scanner discovered, and a launch target
 * must be one of that title's detected `.exe` candidates inside its install directory.
 * That makes traversal, UNC/device paths, alternate data streams and arbitrary command
 * execution unrepresentable rather than merely filtered.
 */
import path from 'node:path';
import { TuneSmithError } from '../../shared/errors';
import type { DiscoveredGame } from '../../shared/game/types';

const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const DRIVE_ROOT_RE = /^[A-Za-z]:\\$/;
const INVALID_SEGMENT_RE = /[<>:"|?*\u0000-\u001f]/;

function trimTrailingSeparators(value: string): string {
  let trimmed = value;
  while (trimmed.length > 3 && trimmed.endsWith('\\')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/**
 * Normalise a Windows drive-absolute path, or return null.
 *
 * Rejected deliberately: relative paths, UNC/device paths (`\\server`, `\\?\`), `.` or
 * `..` segments, alternate data streams (`file:stream`), control characters, and names
 * Windows cannot represent. Forward slashes are accepted and normalised.
 */
export function normaliseGamePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length < 3 || value.length > 32_767) return null;
  if (!DRIVE_PATH_RE.test(value)) return null;
  if (value.startsWith('\\\\') || value.startsWith('//')) return null;

  const unified = value.replace(/\//g, '\\');
  if (unified.includes('\u0000')) return null;

  // `C:` is the drive; any further colon is an alternate data stream.
  const rest = unified.slice(2);
  if (rest.includes(':')) return null;

  const segments = rest.split('\\').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  if (segments.some((segment) => INVALID_SEGMENT_RE.test(segment))) return null;
  if (segments.some((segment) => /[ .]$/.test(segment))) return null;

  const resolved = path.win32.normalize(unified);
  if (!DRIVE_PATH_RE.test(resolved)) return null;
  return trimTrailingSeparators(resolved);
}

/** Case-insensitive, separator-insensitive key for Windows path comparison. */
export function gamePathKey(value: string): string {
  const normalised = normaliseGamePath(value) ?? value.trim().replace(/\//g, '\\');
  if (DRIVE_ROOT_RE.test(normalised)) return normalised.toLowerCase();
  return trimTrailingSeparators(normalised).toLowerCase();
}

export function isSameGamePath(a: string, b: string): boolean {
  return gamePathKey(a) === gamePathKey(b);
}

/** True only when `child` is strictly inside `parent` (not equal to it). */
export function isInsideGameFolder(parent: string, child: string): boolean {
  const parentKey = trimTrailingSeparators(gamePathKey(parent));
  const childKey = gamePathKey(child);
  const prefix = parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`;
  return childKey.startsWith(prefix);
}

export function findGameById(games: readonly DiscoveredGame[], gameId: string): DiscoveredGame | null {
  return games.find((game) => game.id === gameId) ?? null;
}

/**
 * Resolve a requested folder to a discovered install directory. A folder that was not
 * found by the read-only scanner is refused, even if it exists on disk.
 */
export function resolveGameFolder(requested: unknown, games: readonly DiscoveredGame[]): DiscoveredGame {
  const normalised = normaliseGamePath(requested);
  if (normalised === null) {
    throw new TuneSmithError('invalid-request', 'Game folders must be absolute paths on a local drive.');
  }

  const match = games.find((game) => isSameGamePath(game.installDir, normalised));
  if (match === undefined) {
    throw new TuneSmithError(
      'invalid-request',
      'That folder is not an installed game directory TuneSmith discovered. Rescan the libraries and try again.',
    );
  }
  return match;
}

/**
 * Pick the executable the launcher may start. The candidate must be a detected `.exe`
 * inside the install root; no path from the renderer participates.
 */
export function resolveLaunchExecutable(game: DiscoveredGame): string {
  const installDir = normaliseGamePath(game.installDir);
  if (installDir === null) {
    throw new TuneSmithError('invalid-request', 'The detected install folder is not a safe absolute path.');
  }

  const candidate = game.executablePath ?? game.executables[0]?.path ?? null;
  if (candidate === null) {
    throw new TuneSmithError(
      'unavailable',
      game.packageFamilyName !== null
        ? 'Microsoft Store titles have no directly launchable executable. Start the game from the Xbox app; TuneSmith will apply its profile once the process appears.'
        : 'No executable was detected inside this game folder. Launch the game normally; TuneSmith will still follow its profile.',
    );
  }

  const normalised = normaliseGamePath(candidate);
  if (normalised === null || !/\.exe$/i.test(normalised)) {
    throw new TuneSmithError('invalid-request', 'The detected executable is not a safe absolute .exe path.');
  }
  if (!isInsideGameFolder(installDir, normalised)) {
    throw new TuneSmithError('invalid-request', 'The detected executable is outside the game install folder.');
  }
  if (!game.executables.some((entry) => isSameGamePath(entry.path, normalised))) {
    throw new TuneSmithError('invalid-request', 'The executable is not one of the candidates discovered for this game.');
  }

  return normalised;
}
