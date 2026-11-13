/**
 * Worker sandbox manager.
 *
 * Each extension runs in a fresh, single-use Node worker with a hard heap limit and an
 * outer deadline. The worker executes a synchronous VM script whose only reachable
 * objects are frozen primitives; all communication is validated with the shared zod
 * schemas on both ends. A run that times out, crashes or exceeds its heap is terminated
 * asynchronously and reported as a typed failure — the main process is never blocked.
 */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import {
  PLUGIN_LIMITS,
  PLUGIN_PROTOCOL_VERSION,
  pluginFailure,
  pluginRunRequestSchema,
  pluginWorkerMessageSchema,
  type PluginRunRequest,
  type PluginRunResult,
} from '../../shared/plugins/api';

export interface PluginWorkerLike {
  postMessage(value: unknown): void;
  terminate(): Promise<number> | void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
}

export interface PluginWorkerOptions {
  workerData: { protocolVersion: typeof PLUGIN_PROTOCOL_VERSION };
  resourceLimits: {
    maxOldGenerationSizeMb: number;
    maxYoungGenerationSizeMb: number;
  };
  stdout: boolean;
  stderr: boolean;
}

export type PluginWorkerFactory = (workerPath: string, options: PluginWorkerOptions) => PluginWorkerLike;

/**
 * The worker entry is unpacked from app.asar by electron-builder. Node's worker loader
 * cannot open a module from inside the archive on every Electron/Node combination, so
 * packaged builds point at the adjacent app.asar.unpacked copy.
 */
export function defaultPluginWorkerPath(): string {
  if (!__dirname.includes('app.asar')) return path.join(__dirname, 'plugin-worker.cjs');
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    return path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'main', 'plugin-worker.cjs');
  }
  return path.join(__dirname, 'plugin-worker.cjs');
}

export interface PluginSandboxOptions {
  /** Absolute path to the bundled plugin worker entry. */
  workerPath?: string;
  /** Injection point used by unit tests; production uses node:worker_threads. */
  workerFactory?: PluginWorkerFactory;
  maxConcurrent?: number;
  hardTimeoutMs?: number;
}

interface ActiveRun {
  worker: PluginWorkerLike;
}

export class PluginSandboxManager {
  private readonly workerPath: string;
  private readonly workerFactory: PluginWorkerFactory;
  private readonly maxConcurrent: number;
  private readonly hardTimeoutMs: number;
  private readonly active = new Set<ActiveRun>();
  private disposed = false;

  constructor(options: PluginSandboxOptions = {}) {
    this.workerPath = options.workerPath ?? defaultPluginWorkerPath();
    this.workerFactory =
      options.workerFactory ??
      ((workerPath, workerOptions) =>
        new Worker(workerPath, workerOptions) as unknown as PluginWorkerLike);
    this.maxConcurrent = Math.max(1, Math.min(PLUGIN_LIMITS.maxConcurrent, options.maxConcurrent ?? PLUGIN_LIMITS.maxConcurrent));
    this.hardTimeoutMs = Math.max(
      1,
      Math.min(PLUGIN_LIMITS.hardTimeoutMs, options.hardTimeoutMs ?? PLUGIN_LIMITS.hardTimeoutMs),
    );
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Validate and run one extension. Never throws for plugin-caused failures. */
  run(request: PluginRunRequest): Promise<PluginRunResult> {
    if (this.disposed) {
      return Promise.resolve(pluginFailure('unavailable', 'The plugin sandbox has been shut down.'));
    }
    const parsed = pluginRunRequestSchema.safeParse(request);
    if (!parsed.success) {
      return Promise.resolve(pluginFailure('invalid-request', 'Plugin request did not match the sandbox schema.'));
    }
    if (this.active.size >= this.maxConcurrent) {
      return Promise.resolve(pluginFailure('busy', 'The plugin sandbox is busy. Try again when the active extension finishes.'));
    }

    return new Promise<PluginRunResult>((resolve) => {
      let settled = false;
      let worker: PluginWorkerLike;
      let timeout: NodeJS.Timeout | null = null;
      const run: ActiveRun = { worker: undefined as unknown as PluginWorkerLike };
      this.active.add(run);

      const finish = (result: PluginRunResult): void => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        this.active.delete(run);
        try {
          void worker?.terminate();
        } catch {
          // A worker that already exited needs no cleanup.
        }
        resolve(result);
      };

      try {
        worker = this.workerFactory(this.workerPath, {
          workerData: { protocolVersion: PLUGIN_PROTOCOL_VERSION },
          resourceLimits: {
            maxOldGenerationSizeMb: PLUGIN_LIMITS.maxOldGenerationSizeMb,
            maxYoungGenerationSizeMb: PLUGIN_LIMITS.maxYoungGenerationSizeMb,
          },
          stdout: true,
          stderr: true,
        });
      } catch (error) {
        this.active.delete(run);
        resolve(
          pluginFailure(
            'worker-error',
            `The plugin worker could not start: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      run.worker = worker;

      timeout = setTimeout(() => {
        finish(
          pluginFailure(
            'timeout',
            `Plugin exceeded its ${String(PLUGIN_LIMITS.cpuTimeoutMs)} ms execution window.`,
          ),
        );
      }, this.hardTimeoutMs);
      timeout.unref?.();

      worker.on('message', (raw: unknown) => {
        const message = pluginWorkerMessageSchema.safeParse(raw);
        if (!message.success) {
          finish(pluginFailure('worker-error', 'The plugin worker sent an invalid message.'));
          return;
        }
        if (message.data.type === 'ready') {
          try {
            worker.postMessage({ type: 'execute', request: parsed.data });
          } catch (error) {
            finish(
              pluginFailure(
                'worker-error',
                `The plugin worker could not receive its script: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
          return;
        }
        finish(message.data.payload as PluginRunResult);
      });

      worker.on('error', (error: Error) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory|heap limit/i.test(error.message)) {
          finish(pluginFailure('memory-limit', `Plugin exceeded its ${String(PLUGIN_LIMITS.maxOldGenerationSizeMb)} MB worker heap.`));
          return;
        }
        finish(pluginFailure('worker-error', `Plugin worker failed: ${error.message}`));
      });

      worker.on('exit', (code: number) => {
        if (!settled) {
          finish(pluginFailure('worker-error', `Plugin worker exited before returning a result (code ${String(code)}).`));
        }
      });
    });
  }

  /** Stop every in-flight worker. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const runs = [...this.active];
    this.active.clear();
    await Promise.all(
      runs.map(async ({ worker }) => {
        try {
          await worker.terminate();
        } catch {
          // Already gone.
        }
      }),
    );
  }
}

export function createPluginSandbox(options: PluginSandboxOptions = {}): PluginSandboxManager {
  return new PluginSandboxManager(options);
}
