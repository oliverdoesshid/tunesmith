/**
 * Trigger matching: which profile, if any, corresponds to the foreground window.
 *
 * Deliberately conservative — a title pattern is only consulted after the identity
 * matches, so a stray browser tab named after a game can never activate a profile.
 *
 * Two identity forms are supported:
 *   - `exe`: an image name, as before.
 *   - `packageFamilyName`: the package identity of a Microsoft Store title. This is the
 *     reliable handle for AppContainer apps, whose executable may change between builds
 *     and whose install path is virtualised.
 */
import type { GameProfile } from './types';

export interface RunningProcess {
  pid: number;
  exe: string;
  path?: string | null;
  title?: string | null;
  /** Package identity, when the process is an AppContainer / MSIX app. */
  packageFamilyName?: string | null;
}

export interface TriggerMatch {
  matched: boolean;
  reason: string;
}

/** Single `*` wildcard, case-insensitive, everything else literal. */
export function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function identityMatches(profile: GameProfile, process: RunningProcess): { ok: boolean; reason: string; byPackage: boolean } {
  const trigger = profile.trigger;
  const exeMatch =
    trigger.exe !== undefined && process.exe.toLowerCase() === trigger.exe.toLowerCase();

  const packageName = process.packageFamilyName ?? null;
  const packageMatch =
    trigger.packageFamilyName !== undefined &&
    packageName !== null &&
    packageName.toLowerCase() === trigger.packageFamilyName.toLowerCase();

  const identity = packageName === null ? process.exe : `${process.exe} (${packageName})`;

  if (trigger.exe === undefined && trigger.packageFamilyName === undefined) {
    return { ok: false, reason: 'Profile declares no trigger.', byPackage: false };
  }

  // Both declared: either identity is sufficient. A Store title frequently runs one
  // executable for the game and another for the launcher shell, so requiring both would
  // make the profile unusable.
  if (trigger.exe !== undefined && trigger.packageFamilyName !== undefined) {
    if (!exeMatch && !packageMatch) {
      return {
        ok: false,
        reason: `Foreground is ${identity}, profile targets ${trigger.exe} / ${trigger.packageFamilyName}.`,
        byPackage: false,
      };
    }
    return { ok: true, reason: packageMatch ? `Matched package ${trigger.packageFamilyName}.` : `Matched ${trigger.exe}.`, byPackage: packageMatch };
  }

  if (trigger.exe !== undefined) {
    if (!exeMatch) {
      return { ok: false, reason: `Foreground is ${process.exe}, profile targets ${trigger.exe}.`, byPackage: false };
    }
    return { ok: true, reason: `Matched ${trigger.exe}.`, byPackage: false };
  }

  // Package-only trigger.
  if (packageName === null) {
    return {
      ok: false,
      reason: 'The foreground process has no package identity, so a package-family trigger cannot match it.',
      byPackage: false,
    };
  }
  if (!packageMatch) {
    return { ok: false, reason: `Package ${packageName} does not match ${trigger.packageFamilyName}.`, byPackage: false };
  }
  return { ok: true, reason: `Matched package ${trigger.packageFamilyName}.`, byPackage: true };
}

export function matchTrigger(profile: GameProfile, process: RunningProcess | null): TriggerMatch {
  if (process === null) return { matched: false, reason: 'No foreground process.' };

  const trigger = profile.trigger;

  // An install-path filter only exists for unpackaged executables; the schema rejects it
  // alongside a package trigger, and the guard keeps a hand-edited file from crashing.
  if (trigger.pathPrefix !== undefined) {
    const path = process.path ?? '';
    if (path.length === 0) {
      return { matched: false, reason: 'Process path is unavailable, so the install-path filter cannot be checked.' };
    }
    if (!path.toLowerCase().startsWith(trigger.pathPrefix.toLowerCase())) {
      return { matched: false, reason: `Running from ${path}, profile expects ${trigger.pathPrefix}.` };
    }
  }

  const identity = identityMatches(profile, process);
  if (!identity.ok) return { matched: false, reason: identity.reason };

  if (trigger.titlePattern !== undefined) {
    const title = process.title ?? '';
    if (title.length === 0) return { matched: false, reason: 'Window title is unavailable, so the title filter cannot be checked.' };
    if (!globMatch(title, trigger.titlePattern)) {
      return { matched: false, reason: `Title "${title}" does not match "${trigger.titlePattern}".` };
    }
  }

  return { matched: true, reason: identity.reason };
}

/**
 * First profile whose trigger matches. Ordered by the caller, so a specific profile
 * (with a title filter) can be declared before a generic one.
 */
export function selectProfile(profiles: readonly GameProfile[], foreground: RunningProcess | null): GameProfile | null {
  for (const profile of profiles) {
    if (matchTrigger(profile, foreground).matched) return profile;
  }
  return null;
}

/**
 * Profiles whose trigger is visibly running, used to show "detected but not focused".
 * Both identity forms are reported, and a package match wins over an executable match.
 */
export function detectRunning(
  profiles: readonly GameProfile[],
  running: readonly RunningProcess[],
): { exe: string; profileId: string }[] {
  const found = new Map<string, string>();

  for (const process of running) {
    for (const profile of profiles) {
      const trigger = profile.trigger;
      const exeMatch = trigger.exe !== undefined && process.exe.toLowerCase() === trigger.exe.toLowerCase();
      const packageMatch =
        trigger.packageFamilyName !== undefined &&
        (process.packageFamilyName ?? '').toLowerCase() === trigger.packageFamilyName.toLowerCase();

      if (!exeMatch && !packageMatch) continue;
      const key = trigger.exe?.toLowerCase() ?? trigger.packageFamilyName?.toLowerCase() ?? profile.id;
      if (!found.has(key)) found.set(key, profile.id);
    }
  }

  return [...found.entries()].map(([exe, profileId]) => ({ exe, profileId }));
}
