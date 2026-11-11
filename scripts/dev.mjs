/**
 * Development runner.
 *
 * - esbuild watches the main process and the preload script and rebuilds to dist/.
 * - Vite serves the renderer with HMR.
 * - Electron is (re)launched whenever a main-process or preload bundle is rebuilt.
 *
 * The renderer is also usable on its own via `npm run dev:ui`, in which case the
 * bridge falls back to the in-memory mock (see src/renderer/lib/bridge.ts).
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devUrl = 'http://localhost:5273';

let electron = null;
let restarting = false;

function killElectron() {
  if (!electron || electron.killed) return;
  electron.kill();
  electron = null;
}

function startElectron() {
  if (restarting) return;
  killElectron();
  const bin = path.join(root, 'node_modules/electron/dist/electron.exe');
  electron = spawn(bin, [path.join(root, 'dist/main/index.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, TS_DEV_SERVER_URL: devUrl },
  });
  electron.on('exit', () => {
    if (!restarting) {
      // User closed the window: shut the whole dev session down.
      process.exit(0);
    }
  });
}

function restartElectron(label) {
  restarting = true;
  killElectron();
  // Give the file handle a moment to settle on Windows before relaunching.
  setTimeout(() => {
    restarting = false;
    console.log(`[dev] reloading Electron (${label})`);
    startElectron();
  }, 400);
}

const watchPlugin = {
  name: 'relaunch-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      restartElectron(build.initialOptions.outfile);
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: 'inline',
  logLevel: 'warning',
};

async function main() {
  const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts') });
  await server.listen();
  server.printUrls();

  const mainCtx = await context({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.cjs'),
    plugins: [watchPlugin],
  });
  const preloadCtx = await context({
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(root, 'dist/preload/index.cjs'),
    plugins: [watchPlugin],
  });
  const overlayPreloadCtx = await context({
    ...common,
    entryPoints: [path.join(root, 'src/preload/overlay.ts')],
    outfile: path.join(root, 'dist/preload/overlay.cjs'),
    plugins: [watchPlugin],
  });

  await mainCtx.watch();
  await preloadCtx.watch();
  await overlayPreloadCtx.watch();
  console.log(`[dev] renderer at ${devUrl}`);
}

process.on('SIGINT', () => {
  killElectron();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
