/**
 * Worker-thread entry for community extensions.
 *
 * The worker owns no host services. It validates the incoming execute message, runs the
 * synchronous VM harness with a bounded heap (configured by the manager), and posts one
 * schema-validated result. The manager owns the outer deadline and always terminates
 * the worker after a run, so this process is single-use.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  PLUGIN_LIMITS,
  PLUGIN_PROTOCOL_VERSION,
  pluginExecuteMessageSchema,
  pluginFailure,
  pluginWorkerMessageSchema,
  type PluginWorkerMessage,
} from '../../shared/plugins/api';
import { executePlugin } from './execute';

if (parentPort === null) {
  throw new Error('The plugin worker must be started as a worker thread.');
}

const boot = workerData as { protocolVersion?: unknown } | undefined;
if (boot?.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
  throw new Error('Plugin worker protocol version mismatch.');
}

function send(message: PluginWorkerMessage): void {
  // Validate on the sending side too. If the harness ever regresses, the manager sees a
  // concrete protocol error instead of an unvalidated object crossing the boundary.
  const parsed = pluginWorkerMessageSchema.safeParse(message);
  if (!parsed.success) {
    parentPort?.postMessage({
      type: 'result',
      payload: pluginFailure('invalid-result', 'Plugin worker produced an invalid result envelope.'),
    });
    return;
  }
  parentPort?.postMessage(parsed.data);
}

send({ type: 'ready', protocolVersion: PLUGIN_PROTOCOL_VERSION });

parentPort.on('message', (raw: unknown) => {
  const parsed = pluginExecuteMessageSchema.safeParse(raw);
  if (!parsed.success) {
    send({
      type: 'result',
      payload: pluginFailure('invalid-request', 'Plugin worker received an invalid execute message.'),
    });
    return;
  }

  try {
    const result = executePlugin({
      script: parsed.data.request.script,
      context: parsed.data.request.context,
      input: parsed.data.request.input,
      timeoutMs: PLUGIN_LIMITS.cpuTimeoutMs,
    });
    send({ type: 'result', payload: result });
  } catch (error) {
    send({
      type: 'result',
      payload: pluginFailure(
        'worker-error',
        error instanceof Error ? error.message.slice(0, 1_000) : 'Plugin worker crashed.',
      ),
    });
  }
});
