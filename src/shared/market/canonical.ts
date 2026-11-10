/**
 * Canonical JSON for signatures.
 *
 * Signatures must cover exactly the bytes the verifier reconstructs, so both sides sort
 * object keys recursively and drop nothing. Arrays keep their order (it is meaningful),
 * and only JSON-representable values are accepted.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value, 0));
}

function sortValue(value: unknown, depth: number): unknown {
  if (depth > 32) throw new Error('Canonical JSON exceeded the nesting limit.');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical JSON cannot encode a non-finite number.');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sortValue(item, depth + 1));

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] === undefined) continue;
    sorted[key] = sortValue(record[key], depth + 1);
  }
  return sorted;
}
