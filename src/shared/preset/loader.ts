/**
 * Preset loading: read, integrity-check, parse, validate, policy-evaluate.
 *
 * Nothing here mutates the machine. A preset that fails any stage is reported with a
 * machine-readable failure code and simply never appears as applicable.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatZodIssues, PRESET_LIMITS, presetSchema, type FormattedIssue, type Preset } from './schema';
import { evaluatePresetPolicy, type PolicyFinding } from './policy';

export type TrustLevel = 'bundled-verified' | 'market-verified' | 'unverified';

export type PresetFailureCode = 'read' | 'parse' | 'schema' | 'integrity' | 'duplicate' | 'too-large';

export interface PresetLoadFailure {
  file: string;
  code: PresetFailureCode;
  message: string;
  issues?: FormattedIssue[];
}

export interface LoadedPreset {
  preset: Preset;
  file: string;
  sha256: string;
  trust: TrustLevel;
  findings: PolicyFinding[];
}

export interface LoadResult {
  presets: LoadedPreset[];
  failures: PresetLoadFailure[];
}

const indexSchema = z.strictObject({
  schemaVersion: z.number().int(),
  generatedBy: z.string().optional(),
  presets: z.array(
    z.strictObject({
      file: z.string().min(1).max(200),
      id: z.string().min(1).max(120),
      version: z.string().min(1).max(40),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});

export type PresetIndex = z.infer<typeof indexSchema>;
export type PresetIndexEntry = z.infer<typeof indexSchema>['presets'][number];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type ParsePresetResult =
  | { ok: true; preset: Preset }
  | { ok: false; code: PresetFailureCode; message: string; issues?: FormattedIssue[] };

/** Parse + structural validation only. Pure, so tests can feed hostile strings directly. */
export function parsePreset(text: string): ParsePresetResult {
  if (Buffer.byteLength(text, 'utf8') > PRESET_LIMITS.maxFileBytes) {
    return { ok: false, code: 'too-large', message: `Preset exceeds ${PRESET_LIMITS.maxFileBytes} bytes.` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, code: 'parse', message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = presetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'schema', message: 'Preset failed structural validation.', issues: formatZodIssues(parsed.error) };
  }

  return { ok: true, preset: parsed.data };
}

export interface FileLoadResult {
  preset: LoadedPreset | null;
  failure: PresetLoadFailure | null;
}

export async function loadPresetFile(
  absPath: string,
  entry: PresetIndexEntry | null,
  indexPresent: boolean,
  /** Index written by the marketplace installer (signature checked at install time). */
  marketIndex = false,
): Promise<FileLoadResult> {
  const file = path.basename(absPath);

  let bytes: Buffer;
  try {
    const info = await stat(absPath);
    if (info.size > PRESET_LIMITS.maxFileBytes) {
      return { preset: null, failure: { file, code: 'too-large', message: `File is ${info.size} bytes.` } };
    }
    bytes = await readFile(absPath);
  } catch (err) {
    return { preset: null, failure: { file, code: 'read', message: err instanceof Error ? err.message : String(err) } };
  }

  const digest = sha256Hex(bytes);

  // A published bundle must be fully described by its index. A file that is not
  // listed has unknown provenance, which is exactly the case an attacker wants.
  if (indexPresent && entry === null) {
    return {
      preset: null,
      failure: { file, code: 'integrity', message: 'File is not listed in the preset index.' },
    };
  }
  if (entry !== null && entry.sha256 !== digest) {
    return {
      preset: null,
      failure: {
        file,
        code: 'integrity',
        message: 'Digest mismatch: the file has been modified since the index was generated.',
      },
    };
  }

  const result = parsePreset(bytes.toString('utf8'));
  if (!result.ok) {
    return {
      preset: null,
      failure: { file, code: result.code, message: result.message, ...(result.issues ? { issues: result.issues } : {}) },
    };
  }

  if (entry !== null && (entry.id !== result.preset.id || entry.version !== result.preset.version)) {
    return {
      preset: null,
      failure: {
        file,
        code: 'integrity',
        message: `Index says ${entry.id}@${entry.version} but the file declares ${result.preset.id}@${result.preset.version}.`,
      },
    };
  }

  return {
    preset: {
      preset: result.preset,
      file,
      sha256: digest,
      trust: entry !== null ? (marketIndex ? 'market-verified' : 'bundled-verified') : 'unverified',
      findings: evaluatePresetPolicy(result.preset),
    },
    failure: null,
  };
}

export async function loadPresetDirectory(dir: string): Promise<LoadResult> {
  const presets: LoadedPreset[] = [];
  const failures: PresetLoadFailure[] = [];

  let index: PresetIndex | null = null;
  try {
    const raw = await readFile(path.join(dir, 'index.json'), 'utf8');
    const parsed = indexSchema.safeParse(JSON.parse(raw));
    if (parsed.success) index = parsed.data;
    else failures.push({ file: 'index.json', code: 'schema', message: 'Preset index is malformed.' });
  } catch {
    // Dev mode: no index at all. Everything loads as `unverified` with a warning baked
    // into the trust level rather than silently pretending it was reviewed.
  }

  let files: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'index.json')
      .map((e) => e.name)
      .sort();
  } catch (err) {
    failures.push({ file: dir, code: 'read', message: err instanceof Error ? err.message : String(err) });
    return { presets, failures };
  }

  const seen = new Map<string, string>();
  for (const file of files) {
    const entry = index?.presets.find((p) => p.file === file) ?? null;
    const { preset, failure } = await loadPresetFile(
      path.join(dir, file),
      entry,
      index !== null,
      index?.generatedBy === 'tunesmith-marketplace',
    );
    if (failure) {
      failures.push(failure);
      continue;
    }
    if (!preset) continue;

    const existing = seen.get(preset.preset.id);
    if (existing !== undefined) {
      failures.push({
        file,
        code: 'duplicate',
        message: `Preset id "${preset.preset.id}" is already provided by ${existing}.`,
      });
      continue;
    }
    seen.set(preset.preset.id, file);
    presets.push(preset);
  }

  return { presets, failures };
}
