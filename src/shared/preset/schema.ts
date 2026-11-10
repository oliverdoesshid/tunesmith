/**
 * The preset schema: structural validation only.
 *
 * Split of responsibilities (this is the core of the "safe parser" requirement):
 *   1. structural  — this file. Strict objects, closed enums, charset and length
 *                    limits. Rejects unknown keys, so a preset cannot smuggle
 *                    fields a future engine version might honour.
 *   2. semantic    — ./policy.ts. Registry tiering, protected services, action
 *                    budgets, type/data coherence. Produces findings with severity.
 *   3. execution   — ../main/engine. Only typed actions are ever dispatched.
 *
 * A `Preset` that parses is *not* automatically safe to apply; it is merely
 * well-formed. `evaluatePresetPolicy` decides whether it may run.
 */
import { z } from 'zod';
import type { RegData, RegType } from '../types';
import { DRIVE_TYPES, PRIORITY_CLASSES, REGISTRY_HIVES, REGISTRY_VALUE_TYPES, RISK_LEVELS, SERVICE_STARTUP_MODES } from '../types';
import { POWER_PLAN_IDS, POWER_SETTING_IDS } from '../power';

export const PRESET_SCHEMA_VERSION = 1 as const;

export const PRESET_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxProfiles: 12,
  maxActionsPerProfile: 120,
  maxRegistryActions: 60,
  maxServiceActions: 40,
  maxPriorityActions: 12,
  maxPowerSettings: 12,
  maxDeviceInterruptActions: 8,
  maxIrqPriorityActions: 8,
  maxNetworkActions: 4,
  maxRegistryStringBytes: 1024,
} as const;

export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
/** Tokens may use `*` for a single wildcard segment. */
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._*-]{0,63}$/;
export const SERVICE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * Processes are named, never pathed: no directory separators and no drive letters.
 * Spaces are allowed because real image names contain them (`Adobe Premiere Pro.exe`).
 */
export const PROCESS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,95}\.exe$/i;
export const REG_VALUE_NAME_RE = /^[A-Za-z0-9_.(), -]{1,64}$/;
export const REG_PATH_RE = /^[A-Za-z0-9_\\{}()., -]{1,220}$/;

export const RESTORE_POINT_MODES = ['required', 'preferred', 'none'] as const;
export type RestorePointMode = (typeof RESTORE_POINT_MODES)[number];

const idSchema = z.string().regex(PRESET_ID_RE, 'must be lowercase kebab-case, 3-64 chars');
const semverSchema = z.string().regex(SEMVER_RE, 'must be a semantic version');
const tokenSchema = z.string().regex(TOKEN_RE, 'must be a hardware token, `*` wildcard allowed');
const dataSchema = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  z.string().max(PRESET_LIMITS.maxRegistryStringBytes),
]);

/**
 * Registry paths are relative to their hive and are restricted to a conservative
 * charset. Even though `reg.exe` is always invoked with an argv array (never a
 * shell), narrowing the input removes whole classes of parser edge cases.
 */
const registryPathSchema = z
  .string()
  .regex(REG_PATH_RE, 'contains characters outside the allowed set')
  .refine((p) => !p.startsWith('\\') && !p.endsWith('\\'), 'must not start or end with a backslash')
  .refine((p) => !p.includes('\\\\'), 'must not contain empty path segments')
  .refine((p) => !p.includes('..'), 'must not contain relative segments')
  .refine((p) => !/^hkey_/i.test(p), 'must not repeat the hive inside the path');

/**
 * A registry write is only meaningful when the value type and the data agree.
 * This is structural, not policy: a preset that says `REG_DWORD` and supplies a word
 * is malformed, not merely risky.
 */
export function isValueCoherent(type: RegType, data: RegData): boolean {
  switch (type) {
    case 'REG_DWORD':
      return typeof data === 'number' && Number.isInteger(data) && data >= 0 && data <= 0xffffffff;
    case 'REG_QWORD':
      return typeof data === 'number' && Number.isInteger(data) && data >= 0 && data <= Number.MAX_SAFE_INTEGER;
    case 'REG_SZ':
    case 'REG_EXPAND_SZ':
      return typeof data === 'string' && !/[\u0000-\u001f]/.test(data) && data.length <= PRESET_LIMITS.maxRegistryStringBytes;
  }
}

export const registryActionSchema = z
  .strictObject({
    op: z.enum(['set', 'delete']),
    hive: z.enum(REGISTRY_HIVES),
    path: registryPathSchema,
    name: z.string().regex(REG_VALUE_NAME_RE, 'invalid registry value name'),
    type: z.enum(REGISTRY_VALUE_TYPES).optional(),
    data: dataSchema.optional(),
  })
  .refine(
    (action) => {
      if (action.op === 'delete') return action.type === undefined && action.data === undefined;
      // A `set` that omits type/data is reported by the policy layer with a precise
      // message; anything it does supply must be coherent.
      if (action.type === undefined || action.data === undefined) return true;
      return isValueCoherent(action.type, action.data);
    },
    { message: 'registry type and data must be compatible' },
  );

export const serviceActionSchema = z
  .strictObject({
    name: z.string().regex(SERVICE_NAME_RE, 'invalid service name'),
    startup: z.enum(SERVICE_STARTUP_MODES).optional(),
    delayedStart: z.boolean().optional(),
    stop: z.boolean().optional(),
  })
  .refine((a) => a.startup !== undefined || a.stop === true, 'service entry must change startup or stop the service');

export const priorityActionSchema = z.strictObject({
  process: z.string().regex(PROCESS_NAME_RE, 'process must be a bare *.exe name'),
  priority: z.enum(PRIORITY_CLASSES),
});

const powerSettingSchema = z.strictObject({
  setting: z.enum(POWER_SETTING_IDS),
  value: z.number().int().min(0).max(86400),
});

export const powerActionSchema = z
  .strictObject({
    plan: z.enum(POWER_PLAN_IDS).optional(),
    settings: z.array(powerSettingSchema).max(PRESET_LIMITS.maxPowerSettings).optional(),
  })
  .refine((a) => a.plan !== undefined || (a.settings?.length ?? 0) > 0, 'power entry must change the plan or a setting');

export const deviceInterruptActionSchema = z.strictObject({
  deviceClass: z.enum(['gpu', 'network']),
  /** Optional MSI message cap; the hardware negotiates down power-of-two values. */
  messageLimit: z.number().int().min(1).max(32).optional(),
});

export const irqPriorityActionSchema = z.strictObject({
  irq: z.number().int().min(0).max(255),
  priority: z.enum(['high', 'normal']),
});

export const networkActionSchema = z
  .strictObject({
    tcpAckFrequency: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    tcpNoDelay: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .refine((a) => a.tcpAckFrequency !== undefined || a.tcpNoDelay !== undefined, 'network entry must change at least one value');

export const actionGroupsSchema = z.strictObject({
  registry: z.array(registryActionSchema).max(PRESET_LIMITS.maxRegistryActions).optional(),
  services: z.array(serviceActionSchema).max(PRESET_LIMITS.maxServiceActions).optional(),
  priorities: z.array(priorityActionSchema).max(PRESET_LIMITS.maxPriorityActions).optional(),
  power: powerActionSchema.optional(),
  deviceInterrupts: z.array(deviceInterruptActionSchema).max(PRESET_LIMITS.maxDeviceInterruptActions).optional(),
  irqPriorities: z.array(irqPriorityActionSchema).max(PRESET_LIMITS.maxIrqPriorityActions).optional(),
  network: z.array(networkActionSchema).max(PRESET_LIMITS.maxNetworkActions).optional(),
});

const rangeSchema = z
  .strictObject({
    min: z.number().int().min(0).max(4096).optional(),
    max: z.number().int().min(0).max(4096).optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, 'min must not exceed max');

export const compatibilitySchema = z.strictObject({
  /** Full-signature globs, e.g. `Intel_i7-14*_RTX4*_32GB_*`. */
  signature: z.array(tokenSchema).max(24).optional(),
  cpu: z.array(tokenSchema).max(24).optional(),
  gpu: z.array(tokenSchema).max(24).optional(),
  ramGb: rangeSchema.optional(),
  storage: z.array(z.enum(DRIVE_TYPES)).max(3).optional(),
});

/** Condition attached to a single profile, so one preset can ship hardware variants. */
export const profileConditionSchema = z.strictObject({
  cpu: z.array(tokenSchema).max(24).optional(),
  gpu: z.array(tokenSchema).max(24).optional(),
  ramGb: rangeSchema.optional(),
  storage: z.array(z.enum(DRIVE_TYPES)).max(3).optional(),
  gpuVramGb: rangeSchema.optional(),
  cpuThreads: rangeSchema.optional(),
});

export const profileSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  when: profileConditionSchema.optional(),
  /** Must reference a profile declared earlier in the array. */
  extends: idSchema.optional(),
  actions: actionGroupsSchema,
});

const requiresSchema = z.strictObject({
  os: z
    .strictObject({
      minBuild: z.number().int().min(10240).max(999999).optional(),
      maxBuild: z.number().int().min(10240).max(999999).optional(),
    })
    .optional(),
  elevation: z.boolean().optional(),
  restorePoint: z.enum(RESTORE_POINT_MODES).optional(),
  minAppVersion: semverSchema.optional(),
});

export const presetSchema = z.strictObject({
  /** Accepted for editor tooling; not interpreted at runtime. */
  $schema: z.string().max(300).optional(),
  schemaVersion: z.literal(PRESET_SCHEMA_VERSION),
  signatureVersion: z.literal(1),
  id: idSchema,
  name: z.string().min(3).max(80),
  version: semverSchema,
  description: z.string().min(10).max(2000),
  authors: z
    .array(
      z.strictObject({
        handle: z.string().min(1).max(64),
        url: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(8),
  license: z.string().min(1).max(40),
  homepage: z.string().max(300).optional(),
  risk: z.enum(RISK_LEVELS),
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,24}$/)).max(8),
  requires: requiresSchema.optional(),
  compatibility: compatibilitySchema,
  profiles: z.array(profileSchema).min(1).max(PRESET_LIMITS.maxProfiles),
});

export type Preset = z.infer<typeof presetSchema>;
export type PresetProfile = z.infer<typeof profileSchema>;
export type PresetCompatibility = z.infer<typeof compatibilitySchema>;
export type ProfileCondition = z.infer<typeof profileConditionSchema>;
export type RegistryActionInput = z.infer<typeof registryActionSchema>;
export type ServiceActionInput = z.infer<typeof serviceActionSchema>;
export type PriorityActionInput = z.infer<typeof priorityActionSchema>;
export type PowerActionInput = z.infer<typeof powerActionSchema>;
export type DeviceInterruptActionInput = z.infer<typeof deviceInterruptActionSchema>;
export type IrqPriorityActionInput = z.infer<typeof irqPriorityActionSchema>;
export type NetworkActionInput = z.infer<typeof networkActionSchema>;
export type ActionGroups = z.infer<typeof actionGroupsSchema>;

/** Adapter: zod-shaped registry entry -> normalised domain action. Assumes prior validation. */
export function normalizeRegistryAction(a: RegistryActionInput): { type: RegType; data: RegData } | null {
  if (a.op === 'set' && a.type !== undefined && a.data !== undefined) {
    return { type: a.type, data: a.data };
  }
  return null;
}

export interface FormattedIssue {
  path: string;
  message: string;
}

export function formatZodIssues(error: z.ZodError): FormattedIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((p) => String(p)).join('.') : '(root)',
    message: issue.message,
  }));
}
