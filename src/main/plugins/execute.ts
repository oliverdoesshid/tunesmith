/**
 * Synchronous VM execution harness for one extension run.
 *
 * The script is compiled inside a fresh `vm` context whose global object has a null
 * prototype and contains only the frozen API object and a frozen console facade. Node
 * globals (`process`, `require`, `Buffer`, timers) are absent, string code generation
 * is disabled, and the returned value is serialized *inside the context under the same
 * timeout* before the host parses it. That last step matters: a Proxy returned by a
 * script must not be able to run traps on the host thread after the execution window.
 *
 * This module is pure with respect to Electron and is unit-tested directly. The worker
 * entry only supplies the message channel and resource limits.
 */
import vm from 'node:vm';
import {
  PLUGIN_LIMITS,
  PLUGIN_REGISTRY_KEYS,
  PLUGIN_SERVICE_IDS,
  appendBounded,
  pluginContextSchema,
  pluginFailure,
  pluginJsonSchema,
  pluginRunRequestSchema,
  type PluginContext,
  type PluginJson,
  type PluginRunResult,
} from '../../shared/plugins/api';

function scalarRecord<K extends string, V>(keys: readonly K[], read: (key: K) => V | undefined): Readonly<Record<K, V | undefined>> {
  const output = Object.create(null) as Record<K, V | undefined>;
  for (const key of keys) {
    const value = read(key);
    if (value !== undefined) output[key] = value;
  }
  return Object.freeze(output);
}

/**
 * Functions are null-prototyped too. Otherwise `api.log.constructor` would be the
 * host realm's Function constructor, which is a well-known way out of a vm context.
 */
function detachedFunction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  Object.setPrototypeOf(fn, null);
  return fn;
}

/** Iterative depth check: JSON.parse can produce deeply nested input near the size cap. */
function jsonDepth(value: unknown): number {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  let max = 1;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    max = Math.max(max, current.depth);
    if (max > PLUGIN_LIMITS.maxJsonDepth) return max;
    const item = current.value;
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
    } else if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return max;
}

function timeoutFailure(logs: string[], suggestions: string[]): PluginRunResult {
  return pluginFailure(
    'timeout',
    `Plugin exceeded its ${String(PLUGIN_LIMITS.cpuTimeoutMs)} ms CPU window and was stopped.`,
    logs,
    suggestions,
  );
}

export interface ExecutePluginOptions {
  script: string;
  context: PluginContext;
  input?: string;
  timeoutMs?: number;
}

/**
 * Execute one script. The returned `logs`/`suggestions` are always bounded arrays,
 * including on failure, so the manager can pass them to the UI safely.
 */
export function executePlugin(options: ExecutePluginOptions): PluginRunResult {
  const logs: string[] = [];
  const suggestions: string[] = [];
  const timeoutMs = Math.min(PLUGIN_LIMITS.cpuTimeoutMs, Math.max(1, options.timeoutMs ?? PLUGIN_LIMITS.cpuTimeoutMs));

  const contextResult = pluginContextSchema.safeParse(options.context);
  if (!contextResult.success) {
    return pluginFailure('invalid-request', 'Plugin context did not match the allowlisted schema.', logs, suggestions);
  }
  if (Buffer.byteLength(options.script, 'utf8') > PLUGIN_LIMITS.maxScriptBytes) {
    return pluginFailure('invalid-request', 'Plugin source is larger than the allowed limit.', logs, suggestions);
  }
  const requestResult = pluginRunRequestSchema.safeParse({
    id: '00000000-0000-4000-8000-000000000000',
    script: options.script,
    input: options.input,
    context: contextResult.data,
  });
  if (!requestResult.success) {
    return pluginFailure('invalid-request', 'Plugin request did not match the wire schema.', logs, suggestions);
  }

  const log = detachedFunction((message: unknown): void => appendBounded(logs, message));
  const suggest = detachedFunction((message: unknown): void =>
    appendBounded(suggestions, message, PLUGIN_LIMITS.maxSuggestions),
  );

  const registry = scalarRecord(PLUGIN_REGISTRY_KEYS, (key) => contextResult.data.registry[key]);
  const services = scalarRecord(PLUGIN_SERVICE_IDS, (key) => {
    const state = contextResult.data.services[key];
    if (state === undefined) return undefined;
    // Rebuild the record with a null prototype and freeze it; never expose the host
    // object handed to us by the manager.
    return Object.freeze(
      Object.assign(Object.create(null) as { present: boolean; startType: string }, {
        present: state.present,
        startType: state.startType,
      }),
    );
  });

  const api = Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      registry,
      services,
      input: options.input ?? null,
      generatedAt: contextResult.data.generatedAt,
      log,
      suggest,
    }),
  );

  const consoleFacade = Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, {
      log,
      info: log,
      warn: log,
      error: log,
      debug: log,
    }),
  );

  const sandbox = Object.assign(Object.create(null) as Record<string, unknown>, {
    api,
    console: consoleFacade,
  });

  const context = vm.createContext(sandbox, {
    name: 'tunesmith-extension',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });

  let compiled: vm.Script;
  try {
    compiled = new vm.Script(
      `(function (api) {\n"use strict";\n${options.script}\n})(api);`,
      { filename: 'community-extension.js' },
    );
  } catch (error) {
    return pluginFailure('invalid-request', `Plugin has a syntax error: ${errorMessage(error)}`, logs, suggestions);
  }

  const startedAt = process.hrtime.bigint();
  let value: unknown;
  try {
    value = compiled.runInContext(context, { timeout: timeoutMs, breakOnSigint: false, displayErrors: true });
  } catch (error) {
    if (isTimeoutError(error)) return timeoutFailure(logs, suggestions);
    return pluginFailure('worker-error', `Plugin threw: ${errorMessage(error)}`, logs, suggestions);
  }

  // Inspect and serialize the result inside the VM under the same deadline. A Proxy or
  // custom toJSON must not be able to run traps on the host thread after the window.
  let serialized: string;
  try {
    (sandbox as Record<string, unknown>).__tunesmith_result = value;
    const probe = new vm.Script(
      'typeof __tunesmith_result === "object" && __tunesmith_result !== null && typeof __tunesmith_result.then === "function"',
      { filename: 'extension-result-probe.js' },
    );
    const isAsync = probe.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
    if (isAsync === true) {
      return pluginFailure(
        'invalid-result',
        'Plugin returned a Promise. Extension scripts must be synchronous so their CPU budget is enforceable.',
        logs,
        suggestions,
      );
    }
    const serializer = new vm.Script('JSON.stringify(__tunesmith_result)', { filename: 'extension-result.js' });
    const raw = serializer.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
    serialized = typeof raw === 'string' ? raw : 'null';
  } catch (error) {
    if (isTimeoutError(error)) return timeoutFailure(logs, suggestions);
    return pluginFailure('invalid-result', `Plugin result could not be serialized: ${errorMessage(error)}`, logs, suggestions);
  } finally {
    delete (sandbox as Record<string, unknown>).__tunesmith_result;
  }

  if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_LIMITS.maxResultBytes) {
    return pluginFailure('invalid-result', 'Plugin result is larger than the allowed limit.', logs, suggestions);
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(serialized);
  } catch {
    return pluginFailure('invalid-result', 'Plugin result is not valid JSON.', logs, suggestions);
  }
  if (jsonDepth(parsedValue) > PLUGIN_LIMITS.maxJsonDepth) {
    return pluginFailure('invalid-result', 'Plugin result is nested too deeply.', logs, suggestions);
  }
  const result = pluginJsonSchema.safeParse(parsedValue);
  if (!result.success) {
    return pluginFailure('invalid-result', 'Plugin result did not match the JSON result schema.', logs, suggestions);
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  return {
    ok: true,
    value: result.data as PluginJson,
    logs,
    suggestions,
    durationMs: Math.round(durationMs * 100) / 100,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /script execution timed out/i.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

/** Build a context for tests and for the host adapter without exposing its shape. */
export function emptyPluginContext(now = new Date().toISOString()): PluginContext {
  return { registry: {}, services: {}, generatedAt: now };
}
