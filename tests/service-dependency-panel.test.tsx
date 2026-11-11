// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServiceDependencyGraph, type ServiceRegistryEntry } from '../src/shared/service-graph';
import { ServiceDependencyPanel } from '../src/renderer/components/ServiceDependencyPanel';

afterEach(cleanup);

const RECORDS: ServiceRegistryEntry[] = [
  { name: 'SysMain', displayName: 'SysMain', start: 'Auto', dependsOn: ['RpcSs'], dependsOnGroups: [] },
  { name: 'RpcSs', displayName: 'Remote Procedure Call', start: 'Auto', dependsOn: [], dependsOnGroups: [] },
  { name: 'EventLog', displayName: 'Windows Event Log', start: 'Auto', dependsOn: ['SysMain'], dependsOnGroups: [] },
];

describe('ServiceDependencyPanel', () => {
  it('renders the target, dependent tree and protected cascade warning', () => {
    const graph = buildServiceDependencyGraph(RECORDS, [{ name: 'SysMain', startup: 'Disabled', stop: true }]);
    render(<ServiceDependencyPanel graph={graph} error={null} />);

    expect(screen.getByRole('heading', { name: /service dependency map/i })).toBeTruthy();
    expect(screen.getAllByText('SysMain').length).toBeGreaterThan(0);
    expect(screen.getByText(/Protected dependents may fail/)).toBeTruthy();
    expect(screen.getAllByText('EventLog').length).toBeGreaterThan(0);
    expect(screen.getByText(/Required by/)).toBeTruthy();
    expect(screen.getByText(/Requires/)).toBeTruthy();
  });

  it('shows an accessible warning when the registry read fails', () => {
    render(<ServiceDependencyPanel graph={null} error="PowerShell exited with code 1" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Could not read the service dependency map/)).toBeTruthy();
    expect(screen.getAllByText(/apply-time capture/).length).toBeGreaterThan(0);
  });
});
