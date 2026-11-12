// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameModePanel } from '../src/renderer/components/GameModePanel';
import type { GameStatus } from '../src/shared/game/types';
import type { OsdStatus } from '../src/shared/game/osd';

afterEach(cleanup);

const OSD: OsdStatus = { enabled: false, visible: false, message: null };

const STATUS: GameStatus = {
  watching: true,
  cryoFreeze: false,
  interruptAffinity: false,
  phase: 'idle',
  watcherHealthy: true,
  active: null,
  pendingRestore: null,
  lastError: null,
  topology: null,
  packages: [],
  telemetry: null,
  guard: null,
  profiles: 0,
  pollMs: 2000,
};

function renderPanel(status: GameStatus, onToggleCryoFreeze = vi.fn(), onToggleInterruptAffinity = vi.fn()) {
  render(
    <GameModePanel
      status={status}
      profiles={[]}
      osd={OSD}
      busy={false}
      onToggle={vi.fn()}
      onStop={vi.fn()}
      onToggleCryoFreeze={onToggleCryoFreeze}
      onToggleInterruptAffinity={onToggleInterruptAffinity}
      onToggleOsd={vi.fn()}
    />,
  );
  return onToggleCryoFreeze;
}

describe('GameModePanel Cryo-Freeze', () => {
  it('arms Cryo-Freeze from the game mode controls', () => {
    const onToggleCryoFreeze = renderPanel(STATUS);

    fireEvent.click(screen.getByRole('button', { name: 'Cryo-Freeze on' }));
    expect(onToggleCryoFreeze).toHaveBeenCalledWith(true);
  });

  it('arms IRQ pinning from the game mode controls', () => {
    const onToggleInterruptAffinity = vi.fn();
    renderPanel(STATUS, vi.fn(), onToggleInterruptAffinity);

    fireEvent.click(screen.getByRole('button', { name: 'IRQ pin on' }));
    expect(onToggleInterruptAffinity).toHaveBeenCalledWith(true);
  });

  it('shows the armed state and disables the toggle during an active session', () => {
    const active: GameStatus = {
      ...STATUS,
      cryoFreeze: true,
      interruptAffinity: true,
      phase: 'active',
      active: {
        id: 'session-1',
        profileId: 'cryo-freeze',
        profileName: 'Cryo-Freeze',
        exe: 'game.exe',
        pid: 100,
        startedAt: '2026-01-01T00:00:00.000Z',
        phase: 'active',
        adjustments: [],
        suspended: [{ pid: 300, process: 'OneDrive.exe', cryoFreeze: true }],
      },
    };

    renderPanel(active);

    expect(screen.getByText(/Cryo-Freeze is enabled/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cryo-Freeze off' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/OneDrive.exe \(300\) · Cryo-Freeze/)).toBeTruthy();
  });
});
