import { describe, expect, it } from 'vitest';
import { PLUGIN_LIMITS } from '../src/shared/plugins/api';
import { emptyPluginContext, executePlugin } from '../src/main/plugins/execute';
import { PluginSandboxManager, type PluginWorkerLike, type PluginWorkerOptions } from '../src/main/plugins/sandbox';
import { pluginContextSchema } from '../src/shared/plugins/api';

const CONTEXT = {
  registry: {
    'game-dvr-enabled': 0,
    'game-mode-enabled': 1,
  },
  services: {
    sysmain: { present: true, startType: 'Manual' as const },
  },
  generatedAt: new Date().toISOString(),
};

describe('community extension VM harness', () => {
  it('returns a bounded JSON result and never exposes host globals', () => {
    const result = executePlugin({
      script: `
        api.log('hello');
        api.log('x'.repeat(10));
        api.suggest('try a lower DVR setting');
        let escaped = false;
        try {
          const probe = api.log.constructor('return process')();
          escaped = probe !== undefined;
        } catch {}
        return {
          processType: typeof process,
          requireType: typeof require,
          fsType: typeof fs,
          escaped,
          dvr: api.registry['game-dvr-enabled'],
          input: api.input,
          codeGeneration: (() => { try { return Function('return 1')(); } catch { return 'blocked'; } })(),
        };
      `,
      input: '{"target":"fps"}',
      context: CONTEXT,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      processType: 'undefined',
      requireType: 'undefined',
      fsType: 'undefined',
      escaped: false,
      dvr: 0,
      input: '{"target":"fps"}',
      codeGeneration: 'blocked',
    });
    expect(result.logs).toEqual(['hello', 'xxxxxxxxxx']);
    expect(result.suggestions).toEqual(['try a lower DVR setting']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enforces the synchronous CPU deadline', () => {
    const result = executePlugin({
      script: 'while (true) {}',
      context: CONTEXT,
      timeoutMs: 25,
    }, );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout');
  }, 2_000);

  it('rejects async scripts because their CPU budget would escape the VM timeout', () => {
    const result = executePlugin({
      script: 'return Promise.resolve({ ok: true });',
      context: CONTEXT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-result');
  });

  it('caps log and suggestion collections', () => {
    const result = executePlugin({
      script: `
        for (let i = 0; i < 500; i += 1) { api.log('line ' + i); api.suggest('suggestion ' + i); }
        return null;
      `,
      context: CONTEXT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.logs).toHaveLength(PLUGIN_LIMITS.maxLogs);
    expect(result.suggestions).toHaveLength(PLUGIN_LIMITS.maxSuggestions);
  });

  it('rejects unknown context keys at the schema boundary', () => {
    const parsed = pluginContextSchema.safeParse({
      ...CONTEXT,
      registry: { 'arbitrary-path': 'HKCU\\...' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects oversized results before they reach the manager', () => {
    const result = executePlugin({
      script: "return 'x'.repeat(50000);",
      context: CONTEXT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-result');
  });

  it('provides an empty context helper without invalid required keys', () => {
    expect(emptyPluginContext()).toEqual({
      registry: {},
      services: {},
      generatedAt: expect.any(String),
    });
  });
});

class FakeWorker implements PluginWorkerLike {
  readonly options: PluginWorkerOptions;
  readonly sent: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((value: never) => void)[]>();

  constructor(options: PluginWorkerOptions) {
    this.options = options;
    setTimeout(() => this.emit('message', { type: 'ready', protocolVersion: 1 }), 0);
  }

  postMessage(value: unknown): void {
    this.sent.push(value);
    const execute = value as { type?: string; request?: { id?: string } };
    if (execute.type === 'execute') {
      setTimeout(() => {
        this.emit('message', {
          type: 'result',
          payload: {
            ok: true,
            value: { echoed: execute.request?.id ?? null },
            logs: [],
            suggestions: [],
            durationMs: 1,
          },
        });
      }, 5);
    }
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  on(event: 'message', listener: (value: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (...args: never[]) => void);
    this.listeners.set(event, list);
    return this;
  }

  private emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (arg?: unknown) => void)(value);
    }
  }
}

describe('plugin worker manager', () => {
  const baseRequest = {
    id: 'plugin-run-001',
    script: 'return { ok: true };',
    context: CONTEXT,
  };

  it('passes strict heap limits to the worker', async () => {
    const captured: PluginWorkerOptions[] = [];
    const manager = new PluginSandboxManager({
      workerPath: 'fake-worker.cjs',
      workerFactory: (_path, next) => {
        captured.push(next);
        return new FakeWorker(next);
      },
    });

    const result = await manager.run(baseRequest);
    expect(result.ok).toBe(true);
    expect(captured[0]).toMatchObject({
      resourceLimits: {
        maxOldGenerationSizeMb: PLUGIN_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: PLUGIN_LIMITS.maxYoungGenerationSizeMb,
      },
    });
    expect(captured[0]?.workerData).toEqual({ protocolVersion: 1 });
  });

  it('rejects concurrent work above the quota', async () => {
    const manager = new PluginSandboxManager({
      workerPath: 'fake-worker.cjs',
      workerFactory: (_path, next) => new FakeWorker(next),
      maxConcurrent: 1,
    });
    const first = manager.run(baseRequest);
    const second = await manager.run({ ...baseRequest, id: 'plugin-run-002' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('busy');
    await first;
  });

  it('hard-terminates a worker that never answers', async () => {
    const manager = new PluginSandboxManager({
      workerPath: 'fake-worker.cjs',
      hardTimeoutMs: 30,
      workerFactory: (_path, next) => {
        const worker = new FakeWorker(next);
        worker.postMessage = () => undefined;
        return worker;
      },
    });
    const result = await manager.run(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('timeout');
    await manager.dispose();
  });

  it('rejects a malformed worker response', async () => {
    const manager = new PluginSandboxManager({
      workerPath: 'fake-worker.cjs',
      workerFactory: (_path, next) => {
        const worker = new FakeWorker(next);
        worker.postMessage = (value: unknown) => {
          worker.sent.push(value);
          setTimeout(() => {
            (worker as unknown as { emit(event: string, value: unknown): void }).emit('message', { nope: true });
          }, 1);
        };
        return worker;
      },
    });
    const result = await manager.run(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('worker-error');
  });
});
