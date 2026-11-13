/**
 * Structural validation for game profiles.
 *
 * The same principle as tuning presets: strict objects, closed vocabularies, and every
 * string constrained by a regex that cannot express a command. A game profile can never
 * name a shell command, a path to execute, or a raw process id.
 */
import { z } from 'zod';
import { POWER_PLAN_IDS } from '../power';
import { PROCESS_NAME_RE } from '../preset/schema';

export const GAME_LIMITS = {
  maxBackgroundRules: 12,
  maxNotes: 8,
  /** 4 processor groups x 64, the Windows 11 Pro for Workstations ceiling. */
  maxLogicalProcessors: 256,
} as const;

/** Absolute drive path, no traversal, no shell metacharacters. */
const PATH_PREFIX_RE = /^[A-Za-z]:\\[^<>:"|?*]{0,200}$/;

/** Window titles are free text but must stay printable and shell-neutral. */
const TITLE_PATTERN_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:*&()'!,-]{0,95}$/;

export const processNameSchema = z
  .string()
  .regex(PROCESS_NAME_RE, 'Expected a bare process image name such as "game.exe"');

const affinitySchema = z.strictObject({
  strategy: z.enum(['all-cores', 'physical-cores', 'performance-cores', 'efficiency-cores', 'custom']),
  cores: z
    .array(z.number().int().min(0).max(GAME_LIMITS.maxLogicalProcessors - 1))
    .min(1)
    .max(GAME_LIMITS.maxLogicalProcessors)
    .optional(),
  performanceClass: z.enum(['highest', 'lowest']).optional(),
});

const backgroundRuleSchema = z.strictObject({
  process: processNameSchema,
  action: z.enum(['lower-priority', 'suspend', 'eco-mode']),
  priority: z.enum(['Idle', 'BelowNormal']).optional(),
});

export const gameNetworkSettingsSchema = z
  .strictObject({
    tcpAckFrequency: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    tcpNoDelay: z.union([z.literal(0), z.literal(1)]).optional(),
    interruptModeration: z.enum(['enabled', 'disabled']).optional(),
  })
  .refine(
    (value) =>
      value.tcpAckFrequency !== undefined ||
      value.tcpNoDelay !== undefined ||
      value.interruptModeration !== undefined,
    'A network action must change at least one value',
  );

const guardsSchema = z
  .strictObject({
    maxCpuTempC: z.number().int().min(60).max(105).optional(),
    maxGpuTempC: z.number().int().min(60).max(105).optional(),
    onBattery: z.enum(['restore', 'ignore']).optional(),
    cooldownSeconds: z.number().int().min(30).max(900).optional(),
    sampleSeconds: z.number().int().min(5).max(60).optional(),
  })
  .superRefine((guards, ctx) => {
    const hasThreshold = guards.maxCpuTempC !== undefined || guards.maxGpuTempC !== undefined;
    if (!hasThreshold && guards.onBattery !== 'restore') {
      ctx.addIssue({
        code: 'custom',
        path: ['maxCpuTempC'],
        message: 'A guard needs a temperature limit, onBattery: "restore", or both.',
      });
    }
  });

const actionsSchema = z.strictObject({
  affinity: affinitySchema.optional(),
  priority: z.enum(['Normal', 'AboveNormal', 'High']).optional(),
  gpuPreference: z.enum(['high-performance', 'power-saving']).optional(),
  network: gameNetworkSettingsSchema.optional(),
  flushStandbyMemory: z.boolean().optional(),
  timerHold: z.boolean().optional(),
  powerPlan: z.enum(POWER_PLAN_IDS).optional(),
  backgroundRules: z.array(backgroundRuleSchema).max(GAME_LIMITS.maxBackgroundRules).optional(),
});

/** `Microsoft.SunriseBaseGame_8wekyb3d8bbwe` — package family names are name-publisher. */
const PACKAGE_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

const triggerSchema = z
  .strictObject({
    exe: processNameSchema.optional(),
    packageFamilyName: z
      .string()
      .regex(PACKAGE_FAMILY_RE, 'Expected a package family name such as "Microsoft.Game_8wekyb3d8bbwe"')
      .optional(),
    titlePattern: z.string().regex(TITLE_PATTERN_RE, 'Title pattern contains unsupported characters').optional(),
    pathPrefix: z
      .string()
      .regex(PATH_PREFIX_RE, 'Expected an absolute drive path such as "D:\\\\SteamLibrary"')
      .refine((value) => !value.includes('..'), 'Path prefix must not contain ".."')
      .optional(),
  })
  .superRefine((trigger, ctx) => {
    if (trigger.exe === undefined && trigger.packageFamilyName === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['exe'],
        message: 'A trigger needs an executable name, a package family name, or both.',
      });
    }
    if (trigger.pathPrefix !== undefined && trigger.exe === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['pathPrefix'],
        message: 'An install-path filter needs an executable name; package paths are virtualised.',
      });
    }
  });

export const gameProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'Use lowercase kebab-case, 3-64 characters'),
    name: z.string().min(3).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Expected semver, e.g. 1.0.0'),
    description: z.string().min(20).max(600),
    authors: z.array(z.strictObject({ handle: z.string().min(2).max(60) })).min(1).max(6),
    license: z.string().min(2).max(40),
    risk: z.enum(['conservative', 'moderate', 'aggressive']),
    trigger: triggerSchema,
    actions: actionsSchema,
    guards: guardsSchema.optional(),
    notes: z.array(z.string().min(4).max(240)).max(GAME_LIMITS.maxNotes).optional(),
  })
  .superRefine((profile, ctx) => {
    const affinity = profile.actions.affinity;
    if (affinity?.strategy === 'custom' && (affinity.cores === undefined || affinity.cores.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions', 'affinity', 'cores'],
        message: 'A custom affinity strategy must list the logical processors to use',
      });
    }
    if (affinity !== undefined && affinity.strategy !== 'custom' && affinity.cores !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions', 'affinity', 'cores'],
        message: '`cores` is only meaningful with strategy "custom"',
      });
    }
    if (affinity?.cores !== undefined && new Set(affinity.cores).size !== affinity.cores.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['actions', 'affinity', 'cores'],
        message: 'Duplicate logical processor indices',
      });
    }

    for (const [index, rule] of (profile.actions.backgroundRules ?? []).entries()) {
      if ((rule.action === 'suspend' || rule.action === 'eco-mode') && rule.priority !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', 'backgroundRules', index, 'priority'],
          message: 'A suspended or efficiency-mode process has no priority to set',
        });
      }
      if (rule.action === 'lower-priority' && rule.priority === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', 'backgroundRules', index, 'priority'],
          message: 'Specify Idle or BelowNormal for a priority-only rule',
        });
      }
    }

    const seen = new Set<string>();
    for (const rule of profile.actions.backgroundRules ?? []) {
      const key = rule.process.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', 'backgroundRules'],
          message: `Duplicate background rule for ${rule.process}`,
        });
      }
      seen.add(key);
    }
  });

export type ParsedGameProfile = z.infer<typeof gameProfileSchema>;

export function formatGameIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}
