/**
 * Bridge accessor.
 *
 * In Electron the preload script has already published `window.tunesmith`. When the
 * renderer is served by plain Vite (`npm run dev:ui`) there is no preload, so we fall
 * back to an in-memory mock with the *real* shipped presets compiled against a fixture
 * machine. That keeps one code path for the UI and makes design work possible without
 * an elevated Windows host.
 */
import type { TuneSmithApi } from '../../shared/ipc';
import { createMockBridge } from './mock';

let cached: TuneSmithApi | null = null;

export function getBridge(): TuneSmithApi {
  if (cached !== null) return cached;
  const injected = typeof window === 'undefined' ? undefined : window.tunesmith;
  cached = injected ?? createMockBridge();
  return cached;
}

export function isMockBridge(): boolean {
  return getBridge().mock;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
