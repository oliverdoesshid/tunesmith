/**
 * Preset repository: the single reader of the on-disk preset library.
 *
 * Loads once, caches the parsed result, and exposes lookup by id. The cache is
 * invalidated explicitly (after `presets:hash`) rather than by watching the directory,
 * which keeps the hot path free of races with a half-written file.
 */
import type { LoadResult, LoadedPreset } from '../../shared/preset/loader';
import { loadPresetDirectory } from '../../shared/preset/loader';

export class PresetRepository {
  private readonly dir: string;
  private cache: LoadResult | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  get directory(): string {
    return this.dir;
  }

  async load(force = false): Promise<LoadResult> {
    if (!force && this.cache !== null) return this.cache;
    this.cache = await loadPresetDirectory(this.dir);
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
