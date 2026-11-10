/**
 * Standalone diagnostics entry point.
 *
 * Runs the exact same detection code the app uses, but without Electron, so hardware
 * discovery can be exercised from a terminal or a CI runner:
 *
 *   npm run detect           human summary
 *   npm run detect -- --json machine-readable HardwareSpec
 */
import { detectHardware } from '../src/main/platform/hardware';

export async function main(argv: readonly string[]): Promise<number> {
  const spec = await detectHardware();
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
    return 0;
  }

  const line = (k: string, v: string) => console.log(`  ${k.padEnd(12)} ${v}`);
  console.log('\nHardware signature');
  console.log(`  ${spec.signature}\n`);
  line('CPU', `${spec.cpu.rawName} (${spec.cpu.cores}C/${spec.cpu.threads}T)`);
  line('CPU token', spec.cpu.token);
  for (const gpu of spec.gpus) {
    line('GPU', `${gpu.rawName} [${gpu.kind}] vram=${gpu.vramGb ?? '?'}GB via ${gpu.vramSource}`);
  }
  line('Memory', `${spec.memory.totalGb}GB total, token ${spec.memory.bucketGb}GB`);
  line('Storage', spec.storage.primary ? `${spec.storage.primary.mediaType} (${spec.storage.primary.bus}) ${spec.storage.primary.model}` : 'unknown');
  line('OS', `${spec.os.caption} build ${spec.os.build}`);
  if (spec.warnings.length > 0) {
    console.log('\nWarnings');
    for (const w of spec.warnings) console.log(`  - ${w}`);
  }
  console.log('');
  return 0;
}

// No self-execution guard: scripts/detect.mjs imports this module and awaits `main`.
// A guard keyed on argv would run detection twice, because the bundler preserves it.
