/**
 * Headless entry point.
 *
 * The `#!/usr/bin/env node` shebang is added by the build (`scripts/build.mjs`), not
 * here: esbuild preserves a source shebang, so having both produces a duplicate line
 * that Node refuses to parse.
 *
 * Deliberately thin: it resolves the shared directories, constructs the *same*
 * primitives the Electron app uses (preset repository, journal, lock, executor, system
 * adapter) and hands them to `runCli`. No privilege, policy or mutation logic lives
 * here, so the CLI cannot do anything the desktop app could not.
 *
 * Run with:
 *   node dist/cli/index.cjs apply --preset competitive-fps-low-latency --dry-run
 */
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SystemAdapter } from '../main/engine/adapter';
import { Executor } from '../main/engine/executor';
import { JournalStore } from '../main/engine/journal';
import { SessionLock } from '../main/engine/lock';
import { PresetRepository } from '../main/engine/preset-repository';
import { detectHardware } from '../main/platform/hardware';
import { createRestorePoint } from '../main/platform/restore-point';
import { isElevated } from '../main/runtime';
import { parseArgs } from './args';
import { installedPresetDirectory, presetDirectories } from './paths';
import { runCli, type CliDeps } from './run';

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(path.resolve(__dirname, '../../package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Electron's `userData` on Windows is `%APPDATA%\<productName>`, with productName
 * "TuneSmith". Pointing the CLI at the same directory is what makes a CLI session
 * visible (and undoable) in the desktop app.
 */
function defaultUserData(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'TuneSmith');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const version = await readVersion();
  const preliminary = parseArgs(argv);

  const userData = preliminary.userData ?? defaultUserData();
  const journal = new JournalStore(path.join(userData, 'sessions'));
  const lock = new SessionLock(userData);
  // The desktop creates its writable community directory at startup. Do the same so a
  // first CLI run does not report a harmless ENOENT as a preset-loading failure.
  await mkdir(installedPresetDirectory(userData), { recursive: true });
  // Same sources and trust rules as the desktop app: signed bundled presets plus the
  // marketplace-installed community directory. The CLI is a second entry point into the
  // same pipeline; it must not bypass the integrity gate the GUI enforces.
  const repo = new PresetRepository(
    presetDirectories(path.resolve(__dirname, '../../presets/community'), userData),
  );
  const adapter = new SystemAdapter();
  const executor = new Executor({
    adapter,
    journal,
    lock,
    appVersion: version,
    log: (line) => process.stderr.write(`[engine] ${line}\n`),
    createRestorePoint,
  });

  const deps: CliDeps = {
    version,
    loadPresets: () => repo.load(),
    detect: () => detectHardware(),
    isElevated: () => isElevated(),
    applyPlan: async (plan, options, onProgress) => {
      executor.onProgress = onProgress;
      try {
        return await executor.apply(plan, options);
      } finally {
        executor.onProgress = null;
      }
    },
    rollback: (sessionId) => executor.rollback(sessionId),
    restoreDefaults: () => executor.restoreDefaults(),
    sessions: () => journal.summaries(),
  };

  try {
    return await runCli(argv, deps, {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await journal.closeAll();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
