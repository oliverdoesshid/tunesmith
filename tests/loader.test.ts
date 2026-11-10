import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPresetDirectory, loadPresetFile } from '../src/shared/preset/loader';
import { summarizeFindings } from '../src/shared/preset/policy';
import { makePreset } from './factories';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function presetFile(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(makePreset({ id, ...extra }), null, 2);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('single-file loading', () => {
  it('marks a file verified when the digest matches', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.json');
    const text = presetFile('alpha-preset');
    await writeFile(file, text, 'utf8');

    const result = await loadPresetFile(file, { file: 'a.json', id: 'alpha-preset', version: '1.0.0', sha256: sha(text) }, true);
    expect(result.failure).toBeNull();
    expect(result.preset?.trust).toBe('bundled-verified');
  });

  it('rejects a file whose digest no longer matches', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.json');
    await writeFile(file, presetFile('alpha-preset'), 'utf8');

    const result = await loadPresetFile(file, { file: 'a.json', id: 'alpha-preset', version: '1.0.0', sha256: 'f'.repeat(64) }, true);
    expect(result.preset).toBeNull();
    expect(result.failure?.code).toBe('integrity');
  });

  it('rejects a file that is absent from a published index', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'smuggled.json');
    await writeFile(file, presetFile('smuggled-preset'), 'utf8');

    const result = await loadPresetFile(file, null, true);
    expect(result.failure?.code).toBe('integrity');
  });

  it('rejects an index entry whose id does not match the file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'a.json');
    const text = presetFile('alpha-preset');
    await writeFile(file, text, 'utf8');

    const result = await loadPresetFile(file, { file: 'a.json', id: 'other-preset', version: '1.0.0', sha256: sha(text) }, true);
    expect(result.failure?.code).toBe('integrity');
  });
});

describe('directory loading', () => {
  it('loads without an index and marks everything unverified', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.json'), presetFile('alpha-preset'), 'utf8');
    await writeFile(path.join(dir, 'b.json'), presetFile('beta-preset'), 'utf8');

    const result = await loadPresetDirectory(dir);
    expect(result.failures).toEqual([]);
    expect(result.presets.map((p) => p.preset.id).sort()).toEqual(['alpha-preset', 'beta-preset']);
    expect(result.presets.every((p) => p.trust === 'unverified')).toBe(true);
  });

  it('reports duplicate ids instead of silently shadowing', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.json'), presetFile('same-preset'), 'utf8');
    await writeFile(path.join(dir, 'b.json'), presetFile('same-preset'), 'utf8');

    const result = await loadPresetDirectory(dir);
    expect(result.presets).toHaveLength(1);
    expect(result.failures.some((f) => f.code === 'duplicate')).toBe(true);
  });

  it('keeps a valid index happy and rejects tampering', async () => {
    const dir = await tempDir();
    const good = presetFile('alpha-preset');
    await writeFile(path.join(dir, 'a.json'), good, 'utf8');
    await writeFile(path.join(dir, 'b.json'), presetFile('beta-preset'), 'utf8');

    const index = {
      schemaVersion: 1,
      presets: [{ file: 'a.json', id: 'alpha-preset', version: '1.0.0', sha256: sha(good) }],
    };
    await writeFile(path.join(dir, 'index.json'), JSON.stringify(index), 'utf8');

    const result = await loadPresetDirectory(dir);
    expect(result.presets.map((p) => p.preset.id)).toEqual(['alpha-preset']);
    expect(result.failures.some((f) => f.file === 'b.json' && f.code === 'integrity')).toBe(true);
  });
});

describe('shipped preset library', () => {
  it('every bundled preset is structurally valid and policy-clean', async () => {
    const dir = path.resolve(process.cwd(), 'presets/community');
    const result = await loadPresetDirectory(dir);

    expect(result.failures).toEqual([]);
    expect(result.presets.length).toBeGreaterThanOrEqual(3);

    for (const loaded of result.presets) {
      const findings = summarizeFindings(loaded.findings);
      expect(findings.blocked, `${loaded.preset.id}: ${findings.blockers.join('; ')}`).toBe(false);
    }
  });

  it('ships at least one preset with a conditional profile', async () => {
    const dir = path.resolve(process.cwd(), 'presets/community');
    const { presets } = await loadPresetDirectory(dir);
    const hasConditional = presets.some((p) => p.preset.profiles.some((profile) => profile.when !== undefined));
    expect(hasConditional).toBe(true);
  });

  it('ships a preset that does not target an SSD machine', async () => {
    const dir = path.resolve(process.cwd(), 'presets/community');
    const { presets } = await loadPresetDirectory(dir);
    const hasHddOnly = presets.some((p) => p.preset.compatibility.storage?.includes('HDD') === true);
    expect(hasHddOnly).toBe(true);
  });
});
