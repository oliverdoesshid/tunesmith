import { describe, expect, it } from 'vitest';
import { parseServiceRegistryOutput } from '../src/main/platform/service-registry';
import {
  buildServiceDependencyGraph,
  type ServiceDependencyAction,
  type ServiceGraphNode,
  type ServiceRegistryEntry,
} from '../src/shared/service-graph';

const RECORDS: ServiceRegistryEntry[] = [
  { name: 'SysMain', displayName: 'SysMain', start: 'Auto', dependsOn: ['RpcSs'], dependsOnGroups: [] },
  { name: 'RpcSs', displayName: 'Remote Procedure Call (RPC)', start: 'Auto', dependsOn: ['DcomLaunch'], dependsOnGroups: [] },
  { name: 'DcomLaunch', displayName: 'DCOM Server Process Launcher', start: 'Auto', dependsOn: [], dependsOnGroups: [] },
  { name: 'EventLog', displayName: 'Windows Event Log', start: 'Auto', dependsOn: ['SysMain'], dependsOnGroups: [] },
  { name: 'WSearch', displayName: 'Windows Search', start: 'Auto', dependsOn: ['SysMain'], dependsOnGroups: [] },
];

function names(nodes: readonly ServiceGraphNode[]): string[] {
  return nodes.flatMap((node) => [node.name, ...names(node.children)]);
}

describe('service dependency graph', () => {
  it('maps requires and required-by relationships in both directions', () => {
    const graph = buildServiceDependencyGraph(RECORDS, [
      { name: 'SysMain', startup: 'Disabled', stop: true },
    ]);
    const target = graph.targets[0];

    expect(target?.exists).toBe(true);
    expect(target?.risky).toBe(true);
    expect(target?.affectedCount).toBe(2);
    expect(names(target?.requires ?? [])).toEqual(['RpcSs', 'DcomLaunch']);
    expect(names(target?.requiredBy ?? []).sort()).toEqual(['EventLog', 'WSearch']);
    expect(target?.criticalAffected.map((entry) => entry.name)).toEqual(['EventLog']);
    expect(target?.criticalAffected[0]?.reason).toContain('event logging');
    expect(graph.servicesRead).toBe(5);
    expect(graph.warnings).toContain(
      'Protected services appear in one or more dependent trees; review the red cascade warnings before applying.',
    );
  });

  it('marks a missing target instead of inventing a service', () => {
    const graph = buildServiceDependencyGraph(RECORDS, [{ name: 'GhostSvc', startup: 'Disabled' }]);
    expect(graph.missingTargets).toEqual(['GhostSvc']);
    expect(graph.targets[0]?.exists).toBe(false);
    expect(graph.targets[0]?.requires).toEqual([]);
    expect(graph.warnings[0]).toContain('not present in the SCM registry');
  });

  it('stops cycles without recursing forever', () => {
    const cycle: ServiceRegistryEntry[] = [
      { name: 'Alpha', displayName: 'Alpha', start: 'Auto', dependsOn: ['Beta'], dependsOnGroups: [] },
      { name: 'Beta', displayName: 'Beta', start: 'Auto', dependsOn: ['Alpha'], dependsOnGroups: [] },
    ];
    const target = buildServiceDependencyGraph(cycle, [{ name: 'Alpha', startup: 'Disabled' }]).targets[0];
    expect(target?.requires[0]?.name).toBe('Beta');
    expect(target?.requires[0]?.children[0]?.cycle).toBe(true);
  });

  it('deduplicates actions case-insensitively and keeps the last action', () => {
    const graph = buildServiceDependencyGraph(RECORDS, [
      { name: 'sysmain', startup: 'Manual' },
      { name: 'SysMain', startup: 'Disabled', stop: true },
    ]);
    expect(graph.targets).toHaveLength(1);
    expect(graph.targets[0]?.startup).toBe('Disabled');
    expect(graph.targets[0]?.risky).toBe(true);
  });

  it('labels group dependencies without pretending they are services', () => {
    const withGroup: ServiceRegistryEntry[] = [
      { name: 'Example', displayName: 'Example', start: 'Manual', dependsOn: [], dependsOnGroups: ['PNP_TDI'] },
    ];
    const target = buildServiceDependencyGraph(withGroup, [{ name: 'Example', startup: 'Disabled' }]).targets[0];
    expect(target?.requires[0]).toMatchObject({ name: 'PNP_TDI', kind: 'group', missing: false });
  });
});

describe('SCM registry parser', () => {
  it('normalises single values, arrays and start codes', () => {
    const parsed = parseServiceRegistryOutput([
      { name: 'SysMain', displayName: 'SysMain', start: 2, dependsOn: 'RpcSs', dependsOnGroups: null },
      { name: 'RpcSs', displayName: 'RPC', start: 0, dependsOn: ['DcomLaunch', 'dcomlaunch'] },
      { name: 'ManualSvc', start: 3, dependsOn: [], dependsOnGroups: [] },
      { name: 'DisabledSvc', start: 4 },
      { name: 'IndirectName', displayName: '@%SystemRoot%\\system32\\sample.dll,-1000', start: 2 },
      { name: 'invalid name!', start: 2 },
    ]);

    expect(parsed.map((entry) => entry.name)).toEqual(['SysMain', 'RpcSs', 'ManualSvc', 'DisabledSvc', 'IndirectName']);
    expect(parsed[0]?.dependsOn).toEqual(['RpcSs']);
    expect(parsed[1]?.start).toBe('Boot');
    expect(parsed[1]?.dependsOn).toEqual(['DcomLaunch']);
    expect(parsed[2]?.start).toBe('Manual');
    expect(parsed[3]?.start).toBe('Disabled');
    expect(parsed[4]?.displayName).toBe('');
  });

  it('rejects a malformed top-level payload', () => {
    expect(() => parseServiceRegistryOutput({ services: [] })).toThrow(/service control manager registry/i);
  });
});
