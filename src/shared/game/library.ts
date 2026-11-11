/**
 * Profile-to-library matching.
 *
 * Kept in `shared/` because both the main process (which enriches the IPC result) and
 * the browser-preview mock use exactly the same rules. No filesystem or Node APIs here.
 */
import type { DiscoveredGame, GameLibraryScanResult, GameProfile } from './types';

function normalisedPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** Profiles whose trigger matches an installed title. */
export function matchProfilesForGame(game: DiscoveredGame, profiles: readonly GameProfile[]): GameProfile[] {
  const exeNames = new Set(game.executables.map((entry) => entry.name.toLowerCase()));
  const paths = [game.installDir, ...game.executables.map((entry) => entry.path)].map(normalisedPath);

  return profiles.filter((profile) => {
    const trigger = profile.trigger;
    const exeMatch = trigger.exe !== undefined && exeNames.has(trigger.exe.toLowerCase());
    const packageMatch =
      trigger.packageFamilyName !== undefined &&
      game.packageFamilyName !== null &&
      trigger.packageFamilyName.toLowerCase() === game.packageFamilyName.toLowerCase();

    if (!exeMatch && !packageMatch) return false;
    if (trigger.pathPrefix !== undefined) {
      const prefix = normalisedPath(trigger.pathPrefix);
      if (!paths.some((candidate) => candidate === prefix || candidate.startsWith(`${prefix}\\`))) return false;
    }
    return true;
  });
}

/** Copy a scan with matching profile ids attached; the cached scan is never mutated. */
export function attachProfileMatches(
  scan: GameLibraryScanResult,
  profiles: readonly GameProfile[],
): GameLibraryScanResult {
  return {
    ...scan,
    games: scan.games.map((game) => ({
      ...game,
      profileIds: matchProfilesForGame(game, profiles).map((profile) => profile.id),
    })),
  };
}

/** Profile id -> the first discovered executable/install path that matched it. */
export function installedProfilePaths(
  scan: GameLibraryScanResult,
  profiles: readonly GameProfile[],
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const game of scan.games) {
    const matched = matchProfilesForGame(game, profiles);
    if (matched.length === 0) continue;
    const detected = game.executablePath ?? game.installDir;
    for (const profile of matched) {
      if (!paths.has(profile.id)) paths.set(profile.id, detected);
    }
  }
  return paths;
}
