/**
 * Semantic policy for game profiles.
 *
 * A game profile is more dangerous than a tuning preset: it runs *while the user is
 * playing*, suspends other people's processes, and rewrites affinity. The rules below
 * exist so that a bad profile degrades into "nothing happened", never into a frozen
 * desktop.
 */
import { totalLogicalProcessors } from './affinity';
import type { CpuTopology, GameProfile } from './types';

export interface GameFinding {
  severity: 'block' | 'warn';
  code: string;
  target: string;
  message: string;
}

/**
 * Processes that must never be suspended. Suspending any of these freezes the shell,
 * audio, input, logon, or security response — the machine stops being usable, and a
 * crash of this app would leave it that way until a reboot.
 *
 * This list is intentionally separate from the preset process deny list: that one
 * protects processes from a *priority* change, which is recoverable. This one protects
 * against *suspension*, which is not.
 */
export const SUSPEND_DENYLIST: ReadonlyMap<string, string> = new Map(
  [
    ['system', 'kernel'],
    ['idle', 'kernel'],
    ['registry', 'kernel'],
    ['memory compression', 'kernel'],
    ['smss.exe', 'session manager'],
    ['csrss.exe', 'client/server runtime'],
    ['wininit.exe', 'session initialisation'],
    ['winlogon.exe', 'logon and lock screen'],
    ['services.exe', 'service control manager'],
    ['lsass.exe', 'authentication'],
    ['svchost.exe', 'shared service host'],
    ['lsm.exe', 'local session manager'],
    ['dwm.exe', 'desktop compositor'],
    ['explorer.exe', 'shell and taskbar'],
    ['sihost.exe', 'shell infrastructure'],
    ['shellexperiencehost.exe', 'start menu and shell UI'],
    ['startmenuexperiencehost.exe', 'start menu'],
    ['searchhost.exe', 'search UI'],
    ['textinputhost.exe', 'text input'],
    ['ctfmon.exe', 'input method'],
    ['audiodg.exe', 'audio engine'],
    ['audiosrv.exe', 'audio service'],
    ['spoolsv.exe', 'printing'],
    ['logonui.exe', 'logon UI'],
    ['consent.exe', 'UAC prompt'],
    ['msmpeng.exe', 'defender antimalware'],
    ['mssense.exe', 'defender sensor'],
    ['nissrv.exe', 'defender network inspection'],
    ['securityhealthservice.exe', 'security centre'],
    ['mpdefendercoreservice.exe', 'defender core'],
    ['wudfhost.exe', 'driver framework host'],
    ['dllhost.exe', 'COM surrogate'],
    // The game watcher is a PowerShell child of this app; throttling it blinds detection.
    ['powershell.exe', 'host shell (the watcher itself)'],
    ['pwsh.exe', 'host shell'],
  ].map(([name, reason]) => [name, reason]),
);

/** Never worth suspending, and commonly the reason a game launches at all. */
export const SUSPEND_CAUTION: ReadonlyMap<string, string> = new Map(
  [
    ['steam.exe', 'launcher; suspending it can break overlay and DRM'],
    ['steamwebhelper.exe', 'launcher UI'],
    ['epicgameslauncher.exe', 'launcher'],
    ['battle.net.exe', 'launcher'],
    ['galaxyclient.exe', 'launcher'],
    ['discord.exe', 'voice chat and overlay'],
    ['obs64.exe', 'capture; the user may be recording'],
    ['nvidia share.exe', 'overlay'],
    ['nvcontainer.exe', 'driver container'],
  ].map(([name, reason]) => [name, reason]),
);

const MAX_SUSPENDED = 12;

function isWindowsSystemImage(exe: string): boolean {
  return SUSPEND_DENYLIST.has(exe.toLowerCase());
}

/**
 * Validate a profile against the detected machine.
 *
 * Structural validity is assumed (the schema already ran). This is about whether the
 * profile is *safe to act on here*.
 */
export function evaluateGameProfile(profile: GameProfile, topology: CpuTopology | null): GameFinding[] {
  const findings: GameFinding[] = [];

  if (profile.trigger.exe !== undefined && isWindowsSystemImage(profile.trigger.exe)) {
    findings.push({
      severity: 'block',
      code: 'game.protected-trigger',
      target: profile.trigger.exe,
      message: `${profile.trigger.exe} is a Windows system process and cannot be used as a game trigger.`,
    });
  }

  const affinity = profile.actions.affinity;
  if (affinity !== undefined) {
    // Multi-group machines are supported. Only the documented Windows ceiling is
    // refused, and it is refused rather than silently truncated.
    if (topology !== null && totalLogicalProcessors(topology) > 256) {
      findings.push({
        severity: 'block',
        code: 'game.processor-groups',
        target: profile.id,
        message: `Affinity control supports up to 256 logical processors across processor groups; this machine reports ${totalLogicalProcessors(topology)}.`,
      });
    }
    if (affinity.strategy === 'custom') {
      const cores = affinity.cores ?? [];
      const total = topology === null ? 0 : totalLogicalProcessors(topology);
      const tooHigh = cores.filter((index) => topology !== null && index >= total);
      if (topology !== null && tooHigh.length > 0) {
        findings.push({
          severity: 'block',
          code: 'game.invalid-affinity',
          target: profile.id,
          message: `Logical processor ${tooHigh.join(', ')} does not exist on this machine (${total} available).`,
        });
      }
      if (cores.length === 0) {
        findings.push({
          severity: 'block',
          code: 'game.empty-affinity',
          target: profile.id,
          message: 'A custom affinity plan must select at least one logical processor.',
        });
      }
    }
    if (affinity.strategy === 'performance-cores' && topology !== null && !topology.hybrid) {
      findings.push({
        severity: 'warn',
        code: 'game.not-hybrid',
        target: profile.id,
        message: 'This CPU reports no separate performance cores; the profile will fall back to all cores.',
      });
    }
  }

  if (profile.trigger.packageFamilyName !== undefined && profile.actions.gpuPreference !== undefined) {
    findings.push({
      severity: 'warn',
      code: 'game.packaged-gpu',
      target: profile.id,
      message:
        'Windows has no per-app GPU preference for Microsoft Store packages; that step will be skipped for this title.',
    });
  }

  if (profile.actions.gpuPreference === 'power-saving') {
    findings.push({
      severity: 'warn',
      code: 'game.power-saving-gpu',
      target: profile.id,
      message: 'A power-saving GPU preference will usually lower frame rate; it is unlikely to be what you want for a game.',
    });
  }

  if (profile.actions.flushStandbyMemory === true) {
    findings.push({
      severity: 'warn',
      code: 'game.memory-flush',
      target: profile.id,
      message:
        'Purging the standby list discards cached file pages. It makes free memory look larger but can make the game load slower; enable it only if you have measured a benefit.',
    });
  }

  if (profile.actions.timerHold === true) {
    findings.push({
      severity: 'warn',
      code: 'game.timer-hold',
      target: profile.id,
      message:
        'Holding the global timer at 0.5 ms removes timer-coalescing idle savings while the game runs; stop the session (or the game) to release it. The holder exits on its own if the app crashes.',
    });
  }

  if (profile.actions.network !== undefined) {
    findings.push({
      severity: 'warn',
      code: 'game.network-tuning',
      target: profile.id,
      message:
        'Network tuning changes the TCP stack interface carrying this game\'s established server connection. It requires administrator rights, only affects TCP flows (UDP-only gameplay is unaffected), and may briefly disrupt the adapter if Windows applies the interrupt-moderation property on the next link reset. It is restored when the game exits.',
    });
    if (profile.risk === 'conservative') {
      findings.push({
        severity: 'block',
        code: 'game.conservative-network',
        target: profile.id,
        message: 'A conservative profile must not change TCP or adapter settings.',
      });
    }
  }

  if (profile.guards?.maxCpuTempC !== undefined && profile.guards.maxCpuTempC < 75) {
    findings.push({
      severity: 'warn',
      code: 'game.guard-tight',
      target: profile.id,
      message: `A ${profile.guards.maxCpuTempC}°C CPU guard is tight enough to trip under normal gaming load; expect the profile to release often.`,
    });
  }
  if (profile.guards?.maxGpuTempC !== undefined && profile.guards.maxGpuTempC < 70) {
    findings.push({
      severity: 'warn',
      code: 'game.guard-tight-gpu',
      target: profile.id,
      message: `A ${profile.guards.maxGpuTempC}°C GPU guard is likely to trip on any sustained load.`,
    });
  }

  const rules = profile.actions.backgroundRules ?? [];
  const suspends = rules.filter((rule) => rule.action === 'suspend');

  if (suspends.length > MAX_SUSPENDED) {
    findings.push({
      severity: 'block',
      code: 'game.suspend-budget',
      target: profile.id,
      message: `At most ${MAX_SUSPENDED} processes may be suspended by one profile.`,
    });
  }

  const ecoModes = rules.filter((rule) => rule.action === 'eco-mode');
  if (ecoModes.length > MAX_SUSPENDED) {
    findings.push({
      severity: 'block',
      code: 'game.eco-budget',
      target: profile.id,
      message: `At most ${MAX_SUSPENDED} processes may be put in Efficiency Mode by one profile.`,
    });
  }

  if (profile.risk === 'conservative' && suspends.length > 0) {
    findings.push({
      severity: 'block',
      code: 'game.conservative-suspend',
      target: profile.id,
      message: 'A conservative profile may lower priorities but must not suspend processes.',
    });
  }

  for (const rule of rules) {
    const name = rule.process.toLowerCase();
    const denied = SUSPEND_DENYLIST.get(name);
    if (denied !== undefined) {
      findings.push({
        severity: 'block',
        code: 'game.protected-background',
        target: rule.process,
        message: `${rule.process} is protected (${denied}) and cannot be touched by a game profile.`,
      });
      continue;
    }
    const caution = SUSPEND_CAUTION.get(name);
    if (caution !== undefined && rule.action !== 'lower-priority') {
      const eco = rule.action === 'eco-mode';
      findings.push({
        severity: 'warn',
        code: eco ? 'game.caution-eco' : 'game.caution-suspend',
        target: rule.process,
        message: eco
          ? `Efficiency Mode on ${rule.process}: ${caution}. Reversible, but keep it off chat and capture apps while recording.`
          : `Suspending ${rule.process}: ${caution}. Prefer lowering its priority.`,
      });
    }
  }

  return findings;
}

export function isBlocked(findings: readonly GameFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'block');
}

/** Names the watcher must report on, derived only from validated profiles. */
export function watchList(profiles: readonly GameProfile[]): string[] {
  const names = new Set<string>();
  for (const profile of profiles) {
    if (profile.trigger.exe !== undefined) names.add(profile.trigger.exe.toLowerCase());
    for (const rule of profile.actions.backgroundRules ?? []) names.add(rule.process.toLowerCase());
  }
  return [...names].sort();
}

/** Package family names the watcher must resolve, derived only from validated profiles. */
export function packageList(profiles: readonly GameProfile[]): string[] {
  const names = new Set<string>();
  for (const profile of profiles) {
    const familyName = profile.trigger.packageFamilyName;
    if (familyName !== undefined) names.add(familyName);
  }
  return [...names].sort();
}
