/**
 * Preset repository: the single reader of the on-disk preset library.
 *
 * Loads once, caches the parsed result, and exposes lookup by id. The cache is
 * invalidated explicitly (after `presets:hash`) rather than by watching the directory,
 * which keeps the hot path free of races with a half-written file.
 */
import type { LoadResult, LoadedPreset } from '../../shared/preset/loader';
import { loadPresetDirectory } from '../../shared/preset/loader';

export interface PresetDirectory {
  dir: string;
  /** Published bundles require an Ed25519 signature per preset. */
  requireSignatures?: boolean;
  publicKey?: string;
}

export class PresetRepository {
  private readonly dirs: readonly PresetDirectory[];
  private cache: LoadResult | null = null;

  /** Directories are searched in order; the first provider of a preset id wins. */
  constructor(dirs: string | readonly (string | PresetDirectory)[]) {
    const list = typeof dirs === 'string' ? [dirs] : [...dirs];
    this.dirs = list.map((entry) => (typeof entry === 'string' ? { dir: entry } : entry));
  }

  /** The bundled directory, used by “open folder”. */
  get directory(): string {
    return this.dirs[0]?.dir ?? '';
  }

  async load(force = false): Promise<LoadResult> {
    if (!force && this.cache !== null) return this.cache;

    const presets: LoadResult['presets'] = [];
    const failures: LoadResult['failures'] = [];
    const seen = new Map<string, string>();

    for (const config of this.dirs) {
      const result = await loadPresetDirectory(config.dir, {
        ...(config.requireSignatures !== undefined ? { requireSignatures: config.requireSignatures } : {}),
        ...(config.publicKey !== undefined ? { publicKey: config.publicKey } : {}),
      });
      failures.push(...result.failures);
      for (const preset of result.presets) {
        const existing = seen.get(preset.preset.id);
        if (existing !== undefined) {
          failures.push({
            file: preset.file,
            code: 'duplicate',
            message: `Preset id "${preset.preset.id}" is already provided by ${existing}.`,
          });
          continue;
        }
        seen.set(preset.preset.id, preset.file);
        presets.push(preset);
      }
    }

    this.cache = { presets, failures };
    return this.cache;
  }

  async get(id: string): Promise<LoadedPreset | null> {
    const { presets } = await this.load();
    return presets.find((p) => p.preset.id === id) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
