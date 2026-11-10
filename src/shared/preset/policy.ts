/**
 * Semantic safety policy.
 *
 * The schema says "this is well-formed". This file says "this is allowed to touch
 * the operating system". It is deliberately data-driven: reviewers can audit the
 * tables below without reading any execution code, and the executor never consults
 * these tables (it trusts the compiler), so there is exactly one place where a path
 * is judged.
 *
 * Severity model
 *   block   - the plan must never run. Shown to the user as "unavailable".
 *   consent - runs only after an explicit per-preset acknowledgement in the UI.
 *   warn    - informational; does not gate execution.
 */
import type { Preset, PresetProfile } from './schema';
import { isValueCoherent, PRESET_LIMITS, PROCESS_NAME_RE } from './schema';
import { POWER_SETTINGS, POWER_SETTING_IDS } from '../power';
import type { PresetAction } from '../types';

export type PolicySeverity = 'block' | 'consent' | 'warn';

export interface PolicyFinding {
  severity: PolicySeverity;
  /** Stable machine-readable id, e.g. `registry.blocked`. */
  code: string;
  message: string;
  target?: string;
}

/* ------------------------------------------------------------------ *
 * Registry policy
 * ------------------------------------------------------------------ */

interface RegistryRule {
  prefix: string;
  reason: string;
}

/**
 * Never writable by a preset, at any risk level. These keys either control
 * code execution at boot/logon, protect the OS security posture, or are so
 * load-bearing that a malformed value bricks the install.
 */
const BLOCKED_REGISTRY: readonly RegistryRule[] = [
  { prefix: 'HKLM\\SAM', reason: 'Security Account Manager database' },
  { prefix: 'HKLM\\SECURITY', reason: 'LSA secrets database' },
  { prefix: 'HKLM\\BCD00000000', reason: 'boot configuration data' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', reason: 'logon shell and credential plumbing' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options', reason: 'debugger hijacking primitive' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Svchost', reason: 'service host grouping' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows', reason: 'AppInit_DLLs code injection' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows', reason: 'legacy load/run entries' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Authentication', reason: 'credential providers' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', reason: 'font substitution hijack' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', reason: 'autostart (persistence)' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce', reason: 'autostart (persistence)' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunServices', reason: 'autostart (persistence)' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunServicesOnce', reason: 'autostart (persistence)' },
  { prefix: 'HKLM\\SOFTWARE\\Policies', reason: 'machine group policy' },
  { prefix: 'HKCU\\SOFTWARE\\Policies', reason: 'user group policy' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies', reason: 'legacy policy store' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies', reason: 'legacy policy store' },
  { prefix: 'HKLM\\SOFTWARE\\Classes', reason: 'COM/file association hijack' },
  { prefix: 'HKCU\\SOFTWARE\\Classes', reason: 'COM/file association hijack' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts', reason: 'file association hijack' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders', reason: 'profile path redirection' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', reason: 'profile path redirection' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows Defender', reason: 'antivirus configuration' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows Defender Security Center', reason: 'antivirus configuration' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Ole', reason: 'COM security' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Rpc', reason: 'RPC security' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Services', reason: 'use a `services` action; direct service keys bypass dependency checks' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Lsa', reason: 'local security authority' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot', reason: 'recovery mode configuration' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders', reason: 'authentication providers' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager', reason: 'boot-time file operations and environment' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class', reason: 'driver/device configuration' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls', reason: 'locale and code page' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI', reason: 'code integrity' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard', reason: 'virtualisation-based security' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\WMI', reason: 'WMI persistence' },
];

/** Allowed, but only with an explicit acknowledgement. */
const RESTRICTED_REGISTRY: readonly RegistryRule[] = [
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', reason: 'display driver timeouts; a wrong value can leave the screen black' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server', reason: 'remote desktop exposure' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CrashControl', reason: 'changes crash dump behaviour, which removes post-mortem evidence' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', reason: 'filesystem filters and long-path behaviour' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Network', reason: 'network provider ordering' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power', reason: 'use a `power` action where possible; raw power keys bypass powercfg' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl', reason: 'global scheduler quantum and foreground boost' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', reason: 'MMCSS scheduler reservations' },
];

/** The curated "known tuning surface". Anything here needs no acknowledgement. */
const ALLOWED_REGISTRY: readonly RegistryRule[] = [
  { prefix: 'HKCU\\Control Panel\\Mouse', reason: 'mouse acceleration and polling' },
  { prefix: 'HKCU\\Control Panel\\Desktop', reason: 'window animations and menu delays' },
  { prefix: 'HKCU\\Control Panel\\Keyboard', reason: 'key repeat behaviour' },
  { prefix: 'HKCU\\System\\GameConfigStore', reason: 'Game DVR and scheduling flags' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\GameBar', reason: 'Xbox Game Bar' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR', reason: 'background recording' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects', reason: 'visual effects' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', reason: 'shell behaviour' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\DWM', reason: 'desktop compositor' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences', reason: 'per-application GPU preference' },
  { prefix: 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', reason: 'theme and transparency' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile', reason: 'MMCSS scheduler reservations' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl', reason: 'scheduler quantum' },
  { prefix: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling', reason: 'power throttling opt-out' },
  { prefix: 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting', reason: 'error reporting master toggle' },
];

/**
 * Pattern rules catch whole families of keys that a prefix list would have to
 * enumerate (and would eventually miss): HKCU vs HKLM, WOW6432Node mirrors, and
 * per-vendor subtrees.
 */
const BLOCKED_REGISTRY_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\\currentversion\\(?:run|runonce|runservices|runservicesonce)(?:\\|$)/i,
    reason: 'autostart (persistence), including WOW6432Node mirrors',
  },
  { pattern: /\\winlogon(?:\\|$)/i, reason: 'logon shell and credential plumbing' },
  { pattern: /\\image file execution options(?:\\|$)/i, reason: 'debugger hijacking primitive' },
  { pattern: /\\currentversion\\policies(?:\\|$)/i, reason: 'policy store' },
];

function findBlockedPattern(target: string): { pattern: RegExp; reason: string } | null {
  for (const rule of BLOCKED_REGISTRY_PATTERNS) {
    if (rule.pattern.test(target)) return rule;
  }
  return null;
}

export function normalizeRegistryTarget(hive: string, pathValue: string): string {
  return `${hive}\\${pathValue}`.replace(/\\{2,}/g, '\\').replace(/\\+$/, '');
}

function matchesPrefix(target: string, prefix: string): boolean {
  const t = target.toLowerCase();
  const p = prefix.toLowerCase();
  return t === p || t.startsWith(`${p}\\`);
}

function findRule(target: string, rules: readonly RegistryRule[]): RegistryRule | null {
  for (const rule of rules) {
    if (matchesPrefix(target, rule.prefix)) return rule;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Service policy
 * ------------------------------------------------------------------ */

/** Services whose state must never be altered by a preset, with the reason. */
const PROTECTED_SERVICES: ReadonlyMap<string, string> = new Map(
  (
    [
      ['WinDefend', 'Microsoft Defender antivirus'],
      ['WdNisSvc', 'Defender network inspection'],
      ['Sense', 'Defender advanced threat protection'],
      ['SecurityHealthService', 'Windows security health'],
      ['mpssvc', 'Windows Firewall'],
      ['BFE', 'Base Filtering Engine (firewall and IPsec depend on it)'],
      ['RpcSs', 'COM/RPC endpoint mapper; unrelated services fail without it'],
      ['RpcEptMapper', 'RPC endpoint mapper'],
      ['DcomLaunch', 'DCOM server launch'],
      ['SystemEventsBroker', 'brokered system events'],
      ['BrokerInfrastructure', 'brokered service infrastructure'],
      ['CoreMessagingRegistrar', 'compositor messaging'],
      ['StateRepository', 'application state database'],
      ['Winmgmt', 'WMI; most management tooling depends on it'],
      ['EventLog', 'Windows event logging'],
      ['Schedule', 'Task Scheduler'],
      ['ProfSvc', 'user profile service'],
      ['gpsvc', 'Group Policy client'],
      ['CryptSvc', 'cryptographic services (certificate and update validation)'],
      ['KeyIso', 'CNG key isolation'],
      ['SamSs', 'Security Accounts Manager'],
      ['LsaSrv', 'local security authority'],
      ['nsi', 'network store interface'],
      ['Dhcp', 'DHCP client'],
      ['Dnscache', 'DNS cache'],
      ['NlaSvc', 'network location awareness'],
      ['netprofm', 'network profile manager'],
      ['LanmanWorkstation', 'SMB client'],
      ['LanmanServer', 'SMB server'],
      ['TermService', 'Remote Desktop'],
      ['UmRdpService', 'Remote Desktop user mode'],
      ['SessionEnv', 'Remote Desktop configuration'],
      ['TrustedInstaller', 'Windows module installer'],
      ['msiserver', 'Windows Installer'],
      ['wuauserv', 'Windows Update (disabling it stops security patches)'],
      ['UsoSvc', 'Update Orchestrator'],
      ['WaaSMedicSvc', 'Update Medic'],
      ['audiosrv', 'Windows Audio'],
      ['AudioEndpointBuilder', 'audio endpoint enumeration'],
      ['PlugPlay', 'plug and play'],
      ['Power', 'power policy owner'],
      ['Spooler', 'print spooler (also a remote attack surface: keep the default)'],
    ] as const
  ).map(([name, reason]) => [name.toLowerCase(), reason]),
);

/** Legal to change, but the user should know what breaks. */
const CAUTION_SERVICES: ReadonlyMap<string, string> = new Map(
  (
    [
      ['BITS', 'background transfer; Windows Update and some launchers use it'],
      ['WSearch', 'Windows Search; Start menu and Outlook search degrade'],
      ['SysMain', 'prefetch/Superfetch; on a hard drive this usually hurts'],
      ['WerSvc', 'Windows Error Reporting'],
      ['PcaSvc', 'Program Compatibility Assistant'],
      ['WpnService', 'push notifications'],
      ['dmwappushservice', 'device management push'],
      ['TabletInputService', 'touch and handwriting'],
      ['XblAuthManager', 'Xbox Live auth; some Store games require it'],
      ['XboxNetApiSvc', 'Xbox networking'],
      ['MapsBroker', 'offline maps'],
      ['RemoteRegistry', 'remote registry access (usually a security win to disable)'],
      ['Fax', 'fax'],
      ['RetailDemo', 'retail demo mode'],
    ] as const
  ).map(([name, reason]) => [name.toLowerCase(), reason]),
);

/** Never retarget the priority of these; they own input, audio or security. */
const PROTECTED_PROCESSES: ReadonlySet<string> = new Set(
  (
    [
      'system',
      'system idle process',
      'registry',
      'memcompression',
      'csrss.exe',
      'wininit.exe',
      'winlogon.exe',
      'services.exe',
      'lsass.exe',
      'smss.exe',
      'svchost.exe',
      'dwm.exe',
      'audiodg.exe',
      'fontdrvhost.exe',
      'msmpeng.exe',
      'sgrmbroker.exe',
      'securityhealthservice.exe',
    ] as const
  ).map((s) => s.toLowerCase()),
);

/** A single profile may not disable more than this many services. */
export const MAX_DISABLED_SERVICES_PER_PROFILE = 8;

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

function registryFindings(action: Extract<PresetAction, { kind: 'registry' }>): PolicyFinding[] {
  const target = normalizeRegistryTarget(action.hive, action.path);
  const findings: PolicyFinding[] = [];

  const blocked = findRule(target, BLOCKED_REGISTRY) ?? findBlockedPattern(target);
  if (blocked) {
    return [
      {
        severity: 'block',
        code: 'registry.blocked',
        target,
        message: `Registry key is protected (${blocked.reason}).`,
      },
    ];
  }

  const allowed = findRule(target, ALLOWED_REGISTRY);
  const restricted = findRule(target, RESTRICTED_REGISTRY);
  if (!allowed) {
    if (restricted) {
      findings.push({
        severity: 'consent',
        code: 'registry.restricted',
        target,
        message: `Touches a sensitive key: ${restricted.reason}.`,
      });
    } else {
      findings.push({
        severity: 'consent',
        code: 'registry.unlisted',
        target,
        message: 'Writes a key outside the curated tuning surface.',
      });
    }
  }

  if (action.op === 'set' && !isValueCoherent(action.type, action.data)) {
    findings.push({
      severity: 'block',
      code: 'registry.incoherent',
      target,
      message: `Value type ${action.type} is not compatible with the supplied data shape.`,
    });
  }

  return findings;
}

function serviceFindings(profile: PresetProfile): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const services = profile.actions.services ?? [];
  let disabled = 0;

  for (const svc of services) {
    const key = svc.name.toLowerCase();
    const target = `service:${svc.name}`;

    const protectedReason = PROTECTED_SERVICES.get(key);
    if (protectedReason) {
      findings.push({
        severity: 'block',
        code: 'service.protected',
        target,
        message: `Service is protected: ${protectedReason}.`,
      });
      continue;
    }

    if (svc.startup === 'Disabled') {
      disabled += 1;
    }

    const caution = CAUTION_SERVICES.get(key);
    if (caution) {
      findings.push({
        severity: 'warn',
        code: 'service.caution',
        target,
        message: `Known side effects: ${caution}.`,
      });
    }

    if (svc.delayedStart === true && svc.startup !== 'Automatic') {
      findings.push({
        severity: 'block',
        code: 'service.delayed-incoherent',
        target,
        message: 'delayedStart requires startup to be "Automatic".',
      });
    }
  }

  if (disabled > MAX_DISABLED_SERVICES_PER_PROFILE) {
    findings.push({
      severity: 'block',
      code: 'service.budget',
      message: `Profile disables ${disabled} services; the limit is ${MAX_DISABLED_SERVICES_PER_PROFILE}.`,
    });
  }

  return findings;
}

function priorityFindings(profile: PresetProfile): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const entry of profile.actions.priorities ?? []) {
    const target = `process:${entry.process}`;
    if (!PROCESS_NAME_RE.test(entry.process)) {
      findings.push({ severity: 'block', code: 'priority.invalid', target, message: 'Process must be a bare *.exe name.' });
      continue;
    }
    if (PROTECTED_PROCESSES.has(entry.process.toLowerCase())) {
      findings.push({
        severity: 'block',
        code: 'priority.protected',
        target,
        message: 'Retargeting this process can break input, audio or security.',
      });
      continue;
    }
    if (entry.priority === 'High') {
      findings.push({
        severity: 'warn',
        code: 'priority.high',
        target,
        message: 'High priority can starve the desktop compositor if the process misbehaves.',
      });
    }
    findings.push({
      severity: 'warn',
      code: 'priority.volatile',
      target,
      message: 'Process priority is not persisted; it reverts when the process restarts.',
    });
  }
  return findings;
}

function powerFindings(profile: PresetProfile): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const power = profile.actions.power;
  if (!power) return findings;

  for (const entry of power.settings ?? []) {
    if (!POWER_SETTING_IDS.includes(entry.setting)) {
      findings.push({
        severity: 'block',
        code: 'power.unknown-setting',
        target: entry.setting,
        message: 'Unknown power setting.',
      });
      continue;
    }
    const meta = POWER_SETTINGS[entry.setting];
    if (entry.value < meta.min || entry.value > meta.max) {
      findings.push({
        severity: 'block',
        code: 'power.range',
        target: entry.setting,
        message: `${meta.label} must be between ${meta.min} and ${meta.max}.`,
      });
      continue;
    }
    if (entry.setting === 'processor-min-state' && entry.value >= 100) {
      findings.push({
        severity: 'warn',
        code: 'power.min-state-100',
        target: entry.setting,
        message: 'Pinning the minimum processor state at 100% increases idle heat and power draw.',
      });
    }
    if (entry.setting === 'processor-max-state' && entry.value < 100) {
      findings.push({
        severity: 'warn',
        code: 'power.max-state-limited',
        target: entry.setting,
        message: 'Capping maximum processor state reduces peak performance.',
      });
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Low-level latency actions (requirement 8)
 * ------------------------------------------------------------------ */

/**
 * MSI/IRQ/network actions touch interrupt routing and per-interface TCP state.
 * They are data, not code — every target is enumerated at runtime and captured
 * before mutation — but a wrong value can silence a device, so the whole family
 * requires the aggressive risk level plus a restore-point discipline warning.
 */
function latencyFindings(preset: Preset, profile: PresetProfile): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const deviceInterrupts = profile.actions.deviceInterrupts ?? [];
  const irqPriorities = profile.actions.irqPriorities ?? [];
  const network = profile.actions.network ?? [];
  if (deviceInterrupts.length === 0 && irqPriorities.length === 0 && network.length === 0) return findings;

  if (preset.risk !== 'aggressive') {
    findings.push({
      severity: 'block',
      code: 'preset.risk-mismatch',
      message: 'Interrupt and network-latency actions require the aggressive risk level.',
    });
    return findings;
  }

  if (preset.requires?.restorePoint !== 'required') {
    findings.push({
      severity: 'warn',
      code: 'interrupts.require-restore',
      message: 'Interrupt and network changes are safest with a required restore point.',
    });
  }

  for (const entry of deviceInterrupts) {
    const target = `interrupt:${entry.deviceClass}`;
    if (entry.messageLimit !== undefined) {
      const limit = entry.messageLimit;
      if (limit < 1 || limit > 32 || (limit & (limit - 1)) !== 0) {
        findings.push({
          severity: 'block',
          code: 'interrupts.message-limit',
          target,
          message: `Message limit ${limit} is not negotiable: MSI hardware only accepts powers of two up to 32.`,
        });
      }
    }
    findings.push({
      severity: 'warn',
      code: 'interrupts.enum-acl',
      target,
      message:
        'PCI Enum keys can deny writes even to administrators; the step then fails closed and the plan rolls back. A reboot may be needed for the new mode to take effect.',
    });
  }

  for (const entry of irqPriorities) {
    const target = `irq:${entry.irq}`;
    findings.push({
      severity: 'warn',
      code: 'irq-priority.shared',
      target,
      message:
        `IRQ ${entry.irq} priority affects every device sharing that line, and on MSI-X systems the legacy priority is usually vestigial. Prefer the MSI-X action above.`,
    });
  }

  for (const entry of network) {
    findings.push({
      severity: 'warn',
      code: 'network.blunt',
      target: 'network:tcp',
      message:
        `Applies TcpAckFrequency=${entry.tcpAckFrequency ?? '(unchanged)'} and TCPNoDelay=${entry.tcpNoDelay ?? '(unchanged)'} to every active TCP interface. On lossy or high-latency links this can reduce throughput.`,
    });
  }

  return findings;
}

function actionBudgetFindings(profile: PresetProfile): PolicyFinding[] {
  const total =
    (profile.actions.registry?.length ?? 0) +
    (profile.actions.services?.length ?? 0) +
    (profile.actions.priorities?.length ?? 0) +
    (profile.actions.power?.settings?.length ?? 0) +
    (profile.actions.power?.plan ? 1 : 0) +
    (profile.actions.deviceInterrupts?.length ?? 0) +
    (profile.actions.irqPriorities?.length ?? 0) +
    (profile.actions.network?.length ?? 0);

  if (total > PRESET_LIMITS.maxActionsPerProfile) {
    return [
      {
        severity: 'block',
        code: 'profile.budget',
        message: `Profile "${profile.id}" has ${total} actions; the limit is ${PRESET_LIMITS.maxActionsPerProfile}.`,
      },
    ];
  }
  return [];
}

function structuralFindings(preset: Preset): PolicyFinding[] {
  const findings: PolicyFinding[] = [];

  const seen = new Set<string>();
  for (const profile of preset.profiles) {
    if (seen.has(profile.id)) {
      findings.push({ severity: 'block', code: 'preset.duplicate-profile', message: `Duplicate profile id "${profile.id}".` });
    }
    seen.add(profile.id);
  }

  // `extends` must point at an earlier profile: no forward references, no cycles.
  const declared: string[] = [];
  for (const profile of preset.profiles) {
    if (profile.extends !== undefined) {
      if (!declared.includes(profile.extends)) {
        findings.push({
          severity: 'block',
          code: 'preset.unknown-extends',
          message: `Profile "${profile.id}" extends "${profile.extends}", which is not declared before it.`,
        });
      }
    }
    declared.push(profile.id);
  }

  const restorePoint = preset.requires?.restorePoint ?? 'preferred';
  if (restorePoint === 'none' && preset.risk !== 'conservative') {
    findings.push({
      severity: 'block',
      code: 'preset.restore-point-waiver',
      message: 'Only conservative presets may opt out of a restore point.',
    });
  }

  if (preset.risk === 'conservative') {
    for (const profile of preset.profiles) {
      for (const svc of profile.actions.services ?? []) {
        if (svc.startup === 'Disabled' || svc.stop === true) {
          findings.push({
            severity: 'block',
            code: 'preset.risk-mismatch',
            target: `service:${svc.name}`,
            message: 'A conservative preset may not stop or disable services.',
          });
        }
      }
    }
  }

  if (preset.authors.length === 0) {
    findings.push({ severity: 'warn', code: 'preset.no-author', message: 'Preset has no author.' });
  }

  return findings;
}

/** Full evaluation of a preset across every profile. Used at load time. */
export function evaluatePresetPolicy(preset: Preset): PolicyFinding[] {
  const findings = structuralFindings(preset);

  for (const profile of preset.profiles) {
    findings.push(...actionBudgetFindings(profile));

    for (const entry of profile.actions.registry ?? []) {
      const action: Extract<PresetAction, { kind: 'registry' }> =
        entry.op === 'set'
          ? {
              kind: 'registry',
              op: 'set',
              hive: entry.hive,
              path: entry.path,
              name: entry.name,
              type: entry.type ?? 'REG_SZ',
              data: entry.data ?? '',
            }
          : { kind: 'registry', op: 'delete', hive: entry.hive, path: entry.path, name: entry.name };

      // A `set` without an explicit type/data pair is malformed, not merely risky.
      if (entry.op === 'set' && (entry.type === undefined || entry.data === undefined)) {
        findings.push({
          severity: 'block',
          code: 'registry.incomplete',
          target: normalizeRegistryTarget(entry.hive, entry.path),
          message: `Registry set for "${entry.name}" must include both type and data.`,
        });
        continue;
      }
      findings.push(...registryFindings(action));
    }

    findings.push(...serviceFindings(profile));
    findings.push(...priorityFindings(profile));
    findings.push(...powerFindings(profile));
    findings.push(...latencyFindings(preset, profile));
  }

  return findings;
}

export interface PolicySummary {
  blocked: boolean;
  needsConsent: boolean;
  warnings: number;
  blockers: string[];
  consents: string[];
  warningsList: string[];
}

export function summarizeFindings(findings: readonly PolicyFinding[]): PolicySummary {
  const blockers = findings.filter((f) => f.severity === 'block').map((f) => f.message);
  const consents = findings.filter((f) => f.severity === 'consent').map((f) => f.message);
  const warningsList = findings.filter((f) => f.severity === 'warn').map((f) => f.message);
  return {
    blocked: blockers.length > 0,
    needsConsent: consents.length > 0,
    warnings: warningsList.length,
    blockers,
    consents,
    warningsList,
  };
}
