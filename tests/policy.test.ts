import { describe, expect, it } from 'vitest';
import { evaluatePresetPolicy, summarizeFindings, type PolicyFinding } from '../src/shared/preset/policy';
import { makePreset } from './factories';

function findingsFor(overrides: Record<string, unknown>): PolicyFinding[] {
  return evaluatePresetPolicy(makePreset(overrides));
}

function codes(findings: PolicyFinding[]): string[] {
  return findings.map((f) => f.code);
}

const profileWithRegistry = (entry: Record<string, unknown>) => ({
  profiles: [{ id: 'base', name: 'Base', actions: { registry: [entry] } }],
});

describe('registry policy', () => {
  it('blocks logon and execution hijack keys', () => {
    const winlogon = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKLM',
        path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon',
        name: 'Shell',
        type: 'REG_SZ',
        data: 'evil.exe',
      }),
    );
    expect(summarizeFindings(winlogon).blocked).toBe(true);
    expect(codes(winlogon)).toContain('registry.blocked');

    const ifeo = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKLM',
        path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\notepad.exe',
        name: 'Debugger',
        type: 'REG_SZ',
        data: 'evil.exe',
      }),
    );
    expect(codes(ifeo)).toContain('registry.blocked');
  });

  it('blocks direct service keys and autostart keys', () => {
    expect(
      codes(
        findingsFor(
          profileWithRegistry({
            op: 'set',
            hive: 'HKLM',
            path: 'SYSTEM\\CurrentControlSet\\Services\\DiagTrack',
            name: 'Start',
            type: 'REG_DWORD',
            data: 4,
          }),
        ),
      ),
    ).toContain('registry.blocked');

    expect(
      codes(
        findingsFor(
          profileWithRegistry({
            op: 'set',
            hive: 'HKCU',
            path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
            name: 'Updater',
            type: 'REG_SZ',
            data: 'evil.exe',
          }),
        ),
      ),
    ).toContain('registry.blocked');
  });

  it('blocks keys inside a blocked subtree, not just the root', () => {
    const nested = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKLM',
        path: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management',
        name: 'ClearPageFileAtShutdown',
        type: 'REG_DWORD',
        data: 1,
      }),
    );
    expect(codes(nested)).toContain('registry.blocked');
  });

  it('requires consent for unlisted keys and none for curated ones', () => {
    const curated = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKCU',
        path: 'Control Panel\\Mouse',
        name: 'MouseSpeed',
        type: 'REG_SZ',
        data: '0',
      }),
    );
    expect(summarizeFindings(curated).needsConsent).toBe(false);

    const unlisted = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKCU',
        path: 'SOFTWARE\\SomeVendor\\SomeProduct',
        name: 'Flag',
        type: 'REG_DWORD',
        data: 1,
      }),
    );
    expect(codes(unlisted)).toContain('registry.unlisted');
    expect(summarizeFindings(unlisted).needsConsent).toBe(true);
  });

  it('requires consent for restricted subkeys', () => {
    const findings = findingsFor(
      profileWithRegistry({
        op: 'set',
        hive: 'HKLM',
        path: 'SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers',
        name: 'TdrDelay',
        type: 'REG_DWORD',
        data: 10,
      }),
    );
    expect(codes(findings)).toContain('registry.restricted');
  });

  it('blocks a registry set that omits type or data', () => {
    const findings = findingsFor(
      profileWithRegistry({ op: 'set', hive: 'HKCU', path: 'Control Panel\\Mouse', name: 'MouseSpeed' }),
    );
    expect(codes(findings)).toContain('registry.incomplete');
  });
});

describe('service policy', () => {
  const serviceProfile = (entry: Record<string, unknown>) => ({
    profiles: [{ id: 'base', name: 'Base', actions: { services: [entry] } }],
  });

  it('blocks protected services', () => {
    for (const name of ['WinDefend', 'RpcSs', 'EventLog', 'wuauserv', 'mpssvc']) {
      const findings = findingsFor(serviceProfile({ name, startup: 'Disabled', stop: true }));
      expect(summarizeFindings(findings).blocked, `${name} should be protected`).toBe(true);
      expect(codes(findings)).toContain('service.protected');
    }
  });

  it('is case-insensitive about protected names', () => {
    expect(codes(findingsFor(serviceProfile({ name: 'windefend', startup: 'Disabled' })))).toContain('service.protected');
  });

  it('allows a telemetry service but warns about caution services', () => {
    const diag = findingsFor(serviceProfile({ name: 'DiagTrack', startup: 'Disabled' }));
    expect(summarizeFindings(diag).blocked).toBe(false);

    const search = findingsFor(serviceProfile({ name: 'WSearch', startup: 'Manual' }));
    expect(codes(search)).toContain('service.caution');
    expect(summarizeFindings(search).blocked).toBe(false);
  });

  it('blocks disabling more than the per-profile budget', () => {
    const names = ['DiagTrack', 'dmwappushservice', 'Fax', 'MapsBroker', 'RetailDemo', 'XblAuthManager', 'XboxNetApiSvc', 'WpnService', 'WerSvc'];
    const findings = findingsFor({
      profiles: [
        {
          id: 'base',
          name: 'Base',
          actions: { services: names.map((name) => ({ name, startup: 'Disabled' })) },
        },
      ],
    });
    expect(codes(findings)).toContain('service.budget');
  });

  it('rejects delayedStart without Automatic', () => {
    const findings = findingsFor(serviceProfile({ name: 'DiagTrack', startup: 'Manual', delayedStart: true }));
    expect(codes(findings)).toContain('service.delayed-incoherent');
  });
});

describe('priority policy', () => {
  it('blocks protected processes', () => {
    for (const process of ['lsass.exe', 'csrss.exe', 'svchost.exe', 'dwm.exe', 'MsMpEng.exe']) {
      const findings = findingsFor({
        profiles: [{ id: 'base', name: 'Base', actions: { priorities: [{ process, priority: 'High' }] } }],
      });
      expect(codes(findings), process).toContain('priority.protected');
      expect(summarizeFindings(findings).blocked).toBe(true);
    }
  });

  it('warns that priority is not persisted', () => {
    const findings = findingsFor({
      profiles: [{ id: 'base', name: 'Base', actions: { priorities: [{ process: 'game.exe', priority: 'AboveNormal' }] } }],
    });
    expect(codes(findings)).toContain('priority.volatile');
    expect(summarizeFindings(findings).blocked).toBe(false);
  });

  it('allows spaces in image names', () => {
    const findings = findingsFor({
      profiles: [
        { id: 'base', name: 'Base', actions: { priorities: [{ process: 'Adobe Premiere Pro.exe', priority: 'High' }] } },
      ],
    });
    expect(codes(findings)).not.toContain('priority.invalid');
  });
});

describe('preset-level invariants', () => {
  it('forbids conservative presets from stopping services', () => {
    const findings = findingsFor({
      risk: 'conservative',
      profiles: [{ id: 'base', name: 'Base', actions: { services: [{ name: 'DiagTrack', startup: 'Disabled' }] } }],
    });
    expect(codes(findings)).toContain('preset.risk-mismatch');
  });

  it('forbids non-conservative presets from waiving the restore point', () => {
    const findings = findingsFor({ requires: { restorePoint: 'none' } });
    expect(codes(findings)).toContain('preset.restore-point-waiver');
  });

  it('rejects duplicate profile ids and forward extends', () => {
    const duplicate = findingsFor({
      profiles: [
        { id: 'base', name: 'Base', actions: {} },
        { id: 'base', name: 'Again', actions: {} },
      ],
    });
    expect(codes(duplicate)).toContain('preset.duplicate-profile');

    const forward = findingsFor({
      profiles: [
        { id: 'base', name: 'Base', extends: 'later', actions: {} },
        { id: 'later', name: 'Later', actions: {} },
      ],
    });
    expect(codes(forward)).toContain('preset.unknown-extends');
  });

  it('blocks out-of-range power values', () => {
    const findings = findingsFor({
      profiles: [
        {
          id: 'base',
          name: 'Base',
          actions: { power: { settings: [{ setting: 'pcie-link-state', value: 7 }] } },
        },
      ],
    });
    expect(codes(findings)).toContain('power.range');
  });
});
