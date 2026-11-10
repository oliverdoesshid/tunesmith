import { describe, expect, it } from 'vitest';
import { parsePreset } from '../src/shared/preset/loader';
import { makePreset } from './factories';

function expectRejected(mutator: (base: Record<string, unknown>) => Record<string, unknown>): void {
  const preset = makePreset();
  const mutated = mutator(JSON.parse(JSON.stringify(preset)) as Record<string, unknown>);
  const result = parsePreset(JSON.stringify(mutated));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe('schema');
}

describe('preset schema', () => {
  it('accepts a well-formed preset', () => {
    const result = parsePreset(JSON.stringify(makePreset()));
    expect(result.ok).toBe(true);
  });

  it('accepts $schema for editor support', () => {
    const result = parsePreset(JSON.stringify(makePreset({ $schema: 'https://example.test/preset.json' })));
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    expectRejected((base) => ({ ...base, runCommand: 'powershell -c calc' }));
  });

  it('rejects unknown keys inside actions', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [
        {
          op: 'set',
          hive: 'HKCU',
          path: 'Software\\Test',
          name: 'X',
          type: 'REG_DWORD',
          data: 1,
          execute: 'calc.exe',
        },
      ];
      return base;
    });
  });

  it('rejects unknown registry hives', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [{ op: 'set', hive: 'HKCR', path: 'Software\\Test', name: 'X', type: 'REG_DWORD', data: 1 }];
      return base;
    });
  });

  it('rejects path traversal in a registry path', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [
        { op: 'set', hive: 'HKCU', path: 'Software\\..\\..\\Windows\\Run', name: 'X', type: 'REG_DWORD', data: 1 },
      ];
      return base;
    });
  });

  it('rejects shell metacharacters in a registry value name', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [
        { op: 'set', hive: 'HKCU', path: 'Software\\Test', name: '$(calc)', type: 'REG_DWORD', data: 1 },
      ];
      return base;
    });
  });

  it('rejects a process given as a path', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.priorities = [{ process: 'C:\\Windows\\System32\\cmd.exe', priority: 'High' }];
      return base;
    });
  });

  it('rejects RealTime priority outright', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.priorities = [{ process: 'game.exe', priority: 'RealTime' }];
      return base;
    });
  });

  it('rejects DWORD data supplied as a string', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [
        { op: 'set', hive: 'HKCU', path: 'Software\\Test', name: 'X', type: 'REG_DWORD', data: 'not-a-number' },
      ];
      return base;
    });
  });

  it('rejects an unsupported value type', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const actions = profiles[0]!.actions as Record<string, unknown>;
      actions.registry = [{ op: 'set', hive: 'HKCU', path: 'Software\\Test', name: 'X', type: 'REG_BINARY', data: '00' }];
      return base;
    });
  });

  it('rejects more profiles than the limit', () => {
    expectRejected((base) => {
      const profiles = base.profiles as Record<string, unknown>[];
      const template = profiles[0]!;
      base.profiles = Array.from({ length: 13 }, (_, i) => ({ ...template, id: `profile-${i}` }));
      return base;
    });
  });

  it('rejects invalid JSON before schema validation', () => {
    const result = parsePreset('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('parse');
  });

  it('rejects oversized documents', () => {
    const result = parsePreset(`{"padding":"${'x'.repeat(300_000)}"}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too-large');
  });
});
