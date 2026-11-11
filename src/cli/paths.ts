/**
 * Preset sources for the headless CLI.
 *
 * This mirrors `createAppState` in the desktop app exactly:
 *   1. bundled presets are individually signed and require an Ed25519 signature;
 *   2. marketplace installs live in the writable user-data community directory and were
 *      already catalog-verified (payload SHA-256 + entry signature) before being written.
 *
 * Keeping the same order means a bundled preset always wins over a marketplace preset
 * with the same id, just as it does in the GUI.
 */
import path from 'node:path';

export interface CliPresetDirectory {
  dir: string;
  requireSignatures?: boolean;
}

export function installedPresetDirectory(userData: string): string {
  return path.join(userData, 'presets', 'community');
}

export function presetDirectories(bundledDir: string, userData: string): CliPresetDirectory[] {
  return [
    { dir: bundledDir, requireSignatures: true },
    { dir: installedPresetDirectory(userData) },
  ];
}
