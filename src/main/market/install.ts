/**
 * Installing a verified preset.
 *
 * The written bytes are the canonical JSON that was signed, so the digest in the local
 * index matches the file the loader reads. Writes are temp-then-rename, and `index.json`
 * is rebuilt from the directory after every install: the loader treats any unlisted file
 * as an integrity failure, so a stale index would make the library unreadable.
 */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TuneSmithError } from '../../shared/errors';
import { canonicalJson } from '../../shared/market/canonical';
import type { MarketEntry } from '../../shared/market/types';
import { sha256Hex } from './verify';

const RESERVED = new Set(['index.json']);

interface IndexFile {
  schemaVersion: number;
  generatedBy?: string;
  presets: { file: string; id: string; version: string; sha256: string }[];
}

async function readIndex(dir: string): Promise<IndexFile> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as Partial<IndexFile>;
    if (Array.isArray(parsed.presets)) {
      return {
        schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
        ...(typeof parsed.generatedBy === 'string' ? { generatedBy: parsed.generatedBy } : {}),
        presets: parsed.presets.filter(
          (entry): entry is IndexFile['presets'][number] =>
            entry !== null &&
            typeof entry === 'object' &&
            typeof entry.file === 'string' &&
            typeof entry.id === 'string' &&
            typeof entry.version === 'string' &&
            typeof entry.sha256 === 'string',
        ),
      };
    }
  } catch {
    // Missing or corrupt: rebuilt below from the actual files.
  }
  return { schemaVersion: 1, presets: [] };
}

async function rebuildIndex(dir: string, existing: IndexFile): Promise<IndexFile> {
  const byFile = new Map(existing.presets.map((entry) => [entry.file, entry]));
  let files: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !RESERVED.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return existing;
  }

  const presets: IndexFile['presets'] = [];
  for (const file of files) {
    const known = byFile.get(file);
    if (known !== undefined) {
      presets.push(known);
      continue;
    }
    try {
      const bytes = await readFile(path.join(dir, file));
      const parsed = JSON.parse(bytes.toString('utf8')) as { id?: unknown; version?: unknown };
      if (typeof parsed.id === 'string' && typeof parsed.version === 'string') {
        presets.push({
          file,
          id: parsed.id,
          version: parsed.version,
          sha256: sha256Hex(bytes.toString('utf8')),
        });
      }
    } catch {
      // Unreadable files are left out; the loader will report them, which is the honest outcome.
    }
  }
  // Drop entries whose file disappeared.
  const present = new Set(files);
  return { schemaVersion: 1, presets: presets.filter((entry) => present.has(entry.file)) };
}

export async function installVerifiedPreset(
  entry: MarketEntry,
  canonical: string,
  dir: string,
): Promise<{ file: string; sha256: string }> {
  if (canonicalJson(entry.preset) !== canonical) {
    throw new TuneSmithError('integrity-failed', 'The preset changed after verification.');
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(entry.preset.id) || RESERVED.has(`${entry.preset.id}.json`)) {
    throw new TuneSmithError('invalid-request', 'The preset id cannot be used as a file name.');
  }

  await mkdir(dir, { recursive: true });
  const file = `${entry.preset.id}.json`;
  const target = path.join(dir, file);
  const tmp = `${target}.tmp`;
  const digest = sha256Hex(canonical);

  await writeFile(tmp, canonical, 'utf8');
  await rename(tmp, target);

  const index = await rebuildIndex(dir, await readIndex(dir));
  const presets = index.presets.filter((candidate) => candidate.file !== file);
  presets.push({ file, id: entry.preset.id, version: entry.preset.version, sha256: digest });
  presets.sort((a, b) => a.file.localeCompare(b.file));

  const next: IndexFile = { schemaVersion: 1, generatedBy: 'tunesmith-marketplace', presets };
  const indexTmp = path.join(dir, 'index.json.tmp');
  await writeFile(indexTmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(indexTmp, path.join(dir, 'index.json'));

  return { file, sha256: digest };
}
