// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/renderer/components/SettingsDialog';
import { DEFAULT_FEATURES, type FeatureVisibility } from '../src/renderer/lib/features';
import type { GameStatus } from '../src/shared/game/types';
import type { OsdStatus } from '../src/shared/game/osd';

afterEach(cleanup);

const GAME: GameStatus = {
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

const OSD: OsdStatus = { enabled: true, visible: false, message: null };

function renderSettings(options: { features?: FeatureVisibility; game?: GameStatus | null } = {}) {
  const props = {
    features: options.features ?? { ...DEFAULT_FEATURES },
    game: options.game === undefined ? GAME : options.game,
    osd: OSD,
    busy: false,
    onClose: vi.fn(),
    onSetFeature: vi.fn(),
    onSetAllFeatures: vi.fn(),
    onToggleGameMode: vi.fn(),
    onToggleCryoFreeze: vi.fn(),
    onToggleInterruptAffinity: vi.fn(),
    onToggleOsd: vi.fn(),
  };
  render(<SettingsDialog {...props} />);
  return props;
}

describe('SettingsDialog', () => {
  it('enables and disables individual workspace features', () => {
    const props = renderSettings({ features: { ...DEFAULT_FEATURES, launcher: false } });

    fireEvent.click(screen.getByRole('checkbox', { name: /Game library/ }));
    expect(props.onSetFeature).toHaveBeenCalledWith('launcher', true);

    fireEvent.click(screen.getByRole('button', { name: 'Disable all' }));
    expect(props.onSetAllFeatures).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Enable all' }));
    expect(props.onSetAllFeatures).toHaveBeenCalledWith(true);
  });

  it('disables game-mode controls when the Game mode feature is off', () => {
    renderSettings({ features: { ...DEFAULT_FEATURES, gameMode: false } });

    for (const name of [/Game mode watcher/, /Cryo-Freeze/, /IRQ pinning/, /Performance OSD/]) {
      expect((screen.getByRole('checkbox', { name }) as HTMLInputElement).disabled).toBe(true);
    }
  });

  it('closes from the button and Escape', () => {
    const props = renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
