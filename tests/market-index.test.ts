import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPresetSignature } from '../src/main/pipeline/integrity';
import { marketIndexSchema } from '../src/shared/market/index-schema';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('static preset market index', () => {
  it('lists every community preset with a matching digest and valid signature', async () => {
    const raw = await readFile(path.join(root, 'market', 'index.json'), 'utf8');
    const parsed = marketIndexSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));

    const communityDir = path.join(root, 'presets', 'community');
    const files = (await readdir(communityDir))
      .filter((file) => file.endsWith('.json') && file !== 'index.json')
      .sort();

    expect(parsed.data.presets.map((entry) => entry.file).sort()).toEqual(files);

    for (const entry of parsed.data.presets) {
      const filePath = path.join(communityDir, entry.file);
      const bytes = await readFile(filePath);

      expect(createHash('sha256').update(bytes).digest('hex'), `${entry.file} digest`).toBe(
        entry.sha256,
      );

      const signature = await verifyPresetSignature({
        filePath,
        bytes,
        manifestSignature: entry.signature,
      });
      if (!signature.ok) throw new Error(`${entry.file}: ${signature.message}`);

      expect(entry.downloadUrl.endsWith(`/presets/community/${entry.file}`)).toBe(true);
    }
  });
});
