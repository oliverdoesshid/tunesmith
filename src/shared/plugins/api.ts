/**
 * Community extension API and the worker <-> host wire contract.
 *
 * Extension scripts are data-driven advisors, not system mutators. They receive a
 * frozen snapshot of a small allowlist of observable registry/service values and can
 * only return a JSON result plus bounded log lines and suggestions. The host applies
 * any resulting change through the normal signed preset/engine pipeline.
 *
 * Every message crossing the worker boundary is validated by zod on both ends. The
 * limits are intentionally duplicated here rather than read from configuration: a
 * compromised profile must not be able to raise its own CPU or memory allowance.
 */
import { z } from 'zod';

export const PLUGIN_PROTOCOL_VERSION = 1 as const;

export const PLUGIN_LIMITS = {
  /** Largest source file accepted by the host. */
  maxScriptBytes: 64 * 1024,
  /** V8 execution window for synchronous plugin code. */
  cpuTimeoutMs: 500,
  /** Outer worker deadline, including startup and serialization. */
  hardTimeoutMs: 1_500,
  /** Concurrent worker processes. Further runs are rejected, never queued forever. */
  maxConcurrent: 2,
  /** V8 heap bounds for the worker. */
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  maxLogs: 100,
  maxLogLength: 500,
  maxSuggestions: 20,
  maxInputBytes: 4 * 1024,
  maxResultBytes: 32 * 1024,
  maxJsonDepth: 8,
} as const;

/**
 * Logical names only. A plugin never sees a hive, key path or arbitrary value name;
 * the host maps these names to exact, read-only registry probes.
 */
export const PLUGIN_REGISTRY_KEYS = [
  'game-dvr-enabled',
  'game-mode-enabled',
  'system-responsiveness',
  'network-throttling-index',
  'win32-priority-separation',
  'hardware-gpu-scheduling',
] as const;
export type PluginRegistryKey = (typeof PLUGIN_REGISTRY_KEYS)[number];

export const PLUGIN_SERVICE_IDS = [
  'sysmain',
  'diagtrack',
  'wer-svc',
  'xbox-game-save',
  'gameinput',
] as const;
export type PluginServiceId = (typeof PLUGIN_SERVICE_IDS)[number];

export const PLUGIN_START_TYPES = ['Boot', 'System', 'Auto', 'Manual', 'Disabled', 'Unknown'] as const;
export type PluginServiceStartType = (typeof PLUGIN_START_TYPES)[number];

export const pluginRegistryValueSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.null(),
]);
export type PluginRegistryValue = z.infer<typeof pluginRegistryValueSchema>;

export const pluginServiceStateSchema = z.strictObject({
  present: z.boolean(),
  startType: z.enum(PLUGIN_START_TYPES),
});
export type PluginServiceState = z.infer<typeof pluginServiceStateSchema>;

export const pluginContextSchema = z.strictObject({
  // `partialRecord` keeps the key allowlist while permitting an unreadable probe to be
  // omitted entirely (for example on a non-Windows test host).
  registry: z.partialRecord(z.enum(PLUGIN_REGISTRY_KEYS), pluginRegistryValueSchema),
  services: z.partialRecord(z.enum(PLUGIN_SERVICE_IDS), pluginServiceStateSchema),
  generatedAt: z.string().datetime(),
});
export type PluginContext = z.infer<typeof pluginContextSchema>;

export type PluginJson =
  | string
  | number
  | boolean
  | null
  | PluginJson[]
  | { [key: string]: PluginJson };

/** Recursive JSON schema. Results are also size/depth checked by the worker. */
export const pluginJsonSchema: z.ZodType<PluginJson> = z.lazy(() =>
  z.union([
    z.string().max(PLUGIN_LIMITS.maxResultBytes),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(pluginJsonSchema).max(1_000),
    z.record(z.string().max(128), pluginJsonSchema),
  ]),
);

const boundedLineSchema = z.string().min(1).max(PLUGIN_LIMITS.maxLogLength);

export const pluginRunRequestSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  script: z.string().min(1).max(PLUGIN_LIMITS.maxScriptBytes),
  /** JSON text, so no host object prototype ever enters the VM context. */
  input: z.string().max(PLUGIN_LIMITS.maxInputBytes).optional(),
  context: pluginContextSchema,
});
export type PluginRunRequest = z.infer<typeof pluginRunRequestSchema>;

export const pluginExecuteMessageSchema = z.strictObject({
  type: z.literal('execute'),
  request: pluginRunRequestSchema,
});
export type PluginExecuteMessage = z.infer<typeof pluginExecuteMessageSchema>;

const pluginSuccessPayloadSchema = z.strictObject({
  ok: z.literal(true),
  value: pluginJsonSchema,
  logs: z.array(boundedLineSchema).max(PLUGIN_LIMITS.maxLogs),
  suggestions: z.array(boundedLineSchema).max(PLUGIN_LIMITS.maxSuggestions),
  durationMs: z.number().finite().min(0).max(PLUGIN_LIMITS.hardTimeoutMs),
});

const pluginFailurePayloadSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum([
      'invalid-request',
      'invalid-result',
      'timeout',
      'memory-limit',
      'worker-error',
      'busy',
      'unavailable',
    ]),
    message: z.string().min(1).max(1_000),
  }),
  logs: z.array(boundedLineSchema).max(PLUGIN_LIMITS.maxLogs),
  suggestions: z.array(boundedLineSchema).max(PLUGIN_LIMITS.maxSuggestions),
});

export const pluginWorkerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ready'),
    protocolVersion: z.literal(PLUGIN_PROTOCOL_VERSION),
  }),
  z.strictObject({
    type: z.literal('result'),
    payload: z.union([pluginSuccessPayloadSchema, pluginFailurePayloadSchema]),
  }),
]);
export type PluginWorkerMessage = z.infer<typeof pluginWorkerMessageSchema>;

export const PLUGIN_FAILURE_CODES = [
  'invalid-request',
  'invalid-result',
  'timeout',
  'memory-limit',
  'worker-error',
  'busy',
  'unavailable',
] as const;
export type PluginFailureCode = (typeof PLUGIN_FAILURE_CODES)[number];

export type PluginRunResult =
  | {
      ok: true;
      value: PluginJson;
      logs: string[];
      suggestions: string[];
      durationMs: number;
    }
  | {
      ok: false;
      error: { code: PluginFailureCode; message: string };
      logs: string[];
      suggestions: string[];
    };

/**
 * The object available to a script as `api`. It is assembled in the worker from
 * primitives, frozen, and has a null prototype. Scripts are synchronous; return a
 * JSON value from the top-level function.
 */
export interface PluginApi {
  readonly registry: Readonly<Record<PluginRegistryKey, PluginRegistryValue | undefined>>;
  readonly services: Readonly<Record<PluginServiceId, PluginServiceState | undefined>>;
  /** Caller-supplied JSON text, already size-limited. */
  readonly input: string | null;
  readonly generatedAt: string;
  log(message: string): void;
  suggest(message: string): void;
}

export function pluginSuccess(
  value: PluginJson,
  logs: string[],
  suggestions: string[],
  durationMs: number,
): PluginRunResult {
  return { ok: true, value, logs, suggestions, durationMs };
}

export function pluginFailure(
  code: PluginFailureCode,
  message: string,
  logs: string[] = [],
  suggestions: string[] = [],
): PluginRunResult {
  return { ok: false, error: { code, message }, logs, suggestions };
}

/** Deterministic, bounded line collection shared by the VM harness and tests. */
export function appendBounded(lines: string[], message: unknown, max: number = PLUGIN_LIMITS.maxLogs): void {
  if (lines.length >= max) return;
  const text = String(message).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return;
  lines.push(text.slice(0, PLUGIN_LIMITS.maxLogLength));
}
