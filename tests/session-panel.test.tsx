// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../src/shared/session';
import { SessionPanel } from '../src/renderer/components/SessionPanel';

afterEach(cleanup);

const interrupted: SessionSummary = {
  id: 'crash-session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  presetId: 'test-preset',
  presetName: 'Test Preset',
  presetVersion: '1.0.0',
  presetRisk: 'moderate',
  signature: 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD',
  status: 'applying',
  restorePoint: { attempted: true, ok: true, detail: 'checkpoint' },
  stepCount: 3,
  pendingRollback: 2,
  interrupted: true,
};

describe('SessionPanel recovery', () => {
  it('surfaces an interrupted session and offers a one-click restore callback', () => {
    const onRollback = vi.fn();

    render(
      <SessionPanel
        sessions={[interrupted]}
        busy={false}
        onRollback={onRollback}
        onRestoreDefaults={vi.fn()}
      />,
    );

    expect(screen.getByText('Interrupted session detected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Previous State' }));
    expect(onRollback).toHaveBeenCalledWith('crash-session-1');
  });
});
