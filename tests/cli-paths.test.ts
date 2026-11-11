import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { presetDirectories } from '../src/cli/paths';

describe('CLI preset sources', () => {
  it('reads signed bundled presets first and marketplace installs second', () => {
    const bundled = path.join('app', 'presets', 'community');
    const userData = path.join('home', 'TuneSmith');
    const dirs = presetDirectories(bundled, userData);

    expect(dirs).toHaveLength(2);
    expect(dirs[0]).toEqual({ dir: bundled, requireSignatures: true });
    expect(dirs[1]).toEqual({
      dir: path.join(userData, 'presets', 'community'),
    });
    expect(dirs[1]?.requireSignatures).toBeUndefined();
  });

  it('uses the same user-data layout as the desktop installer', () => {
    const dirs = presetDirectories('/opt/tunesmith/presets/community', '/home/player/.config/TuneSmith');
    expect(dirs[1]?.dir).toBe(path.join('/home/player/.config/TuneSmith', 'presets', 'community'));
  });
});
