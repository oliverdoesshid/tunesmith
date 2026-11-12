// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLauncherGrid } from '../src/renderer/components/GameLauncherGrid';
import type { DiscoveredGame, ManualGameAddRequest, PickedGamePath } from '../src/shared/game/types';

const game: DiscoveredGame = {
  id: 'manual:fixture',
  name: 'Fixture Game',
  source: 'manual',
  appId: null,
  installDir: 'D:\\Games\\Fixture Game',
  executables: [{ name: 'Fixture.exe', path: 'D:\\Games\\Fixture Game\\Fixture.exe' }],
  executablePath: 'D:\\Games\\Fixture Game\\Fixture.exe',
  packageFamilyName: null,
  profileIds: [],
};

function makeProps() {
  return {
    games: [game],
    loading: false,
    busy: false,
    profiles: [],
    scanErrors: [],
    onBrowseFiles: vi.fn(),
    onLaunch: vi.fn(),
    onAddGame: vi.fn(async (input: ManualGameAddRequest): Promise<DiscoveredGame> => ({ ...game, name: input.name })),
    onRemoveGame: vi.fn(async () => undefined),
    onPickPath: vi.fn(async (kind: 'folder' | 'executable'): Promise<PickedGamePath> => ({
      token: kind === 'folder' ? 'a'.repeat(36) : 'b'.repeat(36),
      path: kind === 'folder' ? 'D:\\Games\\New Game' : 'D:\\Games\\New Game\\NewGame.exe',
      kind,
    })),
    onRefreshLibraries: vi.fn(),
    resolveArtwork: vi.fn(),
  };
}

afterEach(cleanup);

describe('GameLauncherGrid settings', () => {
  it('opens the game settings in place and exposes removal for a manual entry', () => {
    render(<GameLauncherGrid {...makeProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open settings for Fixture Game' }));

    expect(screen.getByText('GAME SETTINGS')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove from launcher' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Back to library' }).length).toBeGreaterThan(0);
  });

  it('adds a manual game through the inline form', async () => {
    const props = makeProps();
    render(<GameLauncherGrid {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add game' }));
    fireEvent.change(screen.getByPlaceholderText('My game'), { target: { value: 'New Game' } });

    const pathFields = screen.getAllByRole('textbox');
    expect((pathFields[1] as HTMLInputElement).readOnly).toBe(true);
    expect((pathFields[2] as HTMLInputElement).readOnly).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Browse…' })[0]!);
    await waitFor(() => expect(screen.getByDisplayValue('D:\\Games\\New Game')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Browse…' })[1]!);
    await waitFor(() =>
      expect(screen.getByDisplayValue('D:\\Games\\New Game\\NewGame.exe')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add to library' }));

    await waitFor(() => {
      expect(props.onAddGame).toHaveBeenCalledWith({
        name: 'New Game',
        installDirToken: 'a'.repeat(36),
        executableToken: 'b'.repeat(36),
      });
    });
  });
});
