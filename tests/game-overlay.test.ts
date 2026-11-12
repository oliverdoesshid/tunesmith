import { describe, expect, it } from 'vitest';
import { OSD_HEIGHT, OSD_WIDTH, placeOverlay } from '../src/main/overlay/geometry';
import { buildOsdState, osdStateKey } from '../src/main/overlay/state';
import { clampFrameSampleMs, buildFrameMonitorScript } from '../src/main/platform/game/frame-script';
import { parseFrameMonitorLine } from '../src/main/platform/game/frame-monitor';
import { buildForegroundScript, parseForegroundLine, parseTasklist } from '../src/main/platform/game/watcher';
import type { FrameSample } from '../src/shared/game/osd';
import type { GameStatus, TelemetrySample } from '../src/shared/game/types';

const TELEMETRY: TelemetrySample = {
  at: '2026-01-01T00:09:00.000Z',
  cpuTempC: 71.4,
  cpuTempSource: 'libre-hardware-monitor',
  gpuTempC: 64.8,
  gpuTempSource: 'libre-hardware-monitor',
  powerDrawW: 182.3,
  powerSource: 'libre-hardware-monitor',
  onAc: true,
  batteryPercent: null,
};

const FRAME: FrameSample = {
  fps: 118,
  low1Fps: 94,
  frameTimeMs: 8.5,
  frames: 118,
  at: '2026-01-01T00:10:00.000Z',
};

const STATUS: GameStatus = {
  watching: true,
  cryoFreeze: false,
  interruptAffinity: false,
  phase: 'active',
  watcherHealthy: true,
  active: {
    id: 'session-1',
    profileId: 'cyberpunk-2077',
    profileName: 'Cyberpunk 2077',
    exe: 'Cyberpunk2077.exe',
    pid: 4242,
    startedAt: '2026-01-01T00:00:00.000Z',
    phase: 'active',
    adjustments: [
      { kind: 'affinity', target: 'Cyberpunk2077.exe', detail: 'physical cores', ok: true },
      { kind: 'priority', target: 'Cyberpunk2077.exe', detail: 'High', ok: true },
      { kind: 'gpu-preference', target: 'wf', detail: 'Skipped', ok: false },
    ],
    suspended: [],
  },
  pendingRestore: null,
  lastError: null,
  topology: null,
  packages: [],
  telemetry: TELEMETRY,
  guard: null,
  profiles: 1,
  pollMs: 2000,
};

describe('overlay placement', () => {
  it('anchors the OSD to the game window and clamps it to the display', () => {
    const placed = placeOverlay(
      { left: 100, top: 50, width: 1280, height: 720 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    expect(placed).toEqual({ x: 118, y: 68, width: OSD_WIDTH, height: OSD_HEIGHT });
  });

  it('keeps the OSD visible when the game starts partly off-screen', () => {
    const placed = placeOverlay(
      { left: -300, top: -200, width: 1600, height: 900 },
      { x: 0, y: 0, width: 1920, height: 1080 },
    );

    expect(placed.x).toBe(18);
    expect(placed.y).toBe(18);
  });

  it('places the OSD on the display that contains the game, not the primary display', () => {
    const placed = placeOverlay(
      { left: 2000, top: 100, width: 1280, height: 720 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    );

    expect(placed.x).toBe(2018);
    expect(placed.y).toBe(118);
  });

  it('clamps a window larger than the display rather than placing the OSD off-screen', () => {
    const placed = placeOverlay(
      { left: 0, top: 0, width: 4000, height: 3000 },
      { x: 0, y: 0, width: 1366, height: 768 },
    );

    expect(placed.x).toBe(18);
    expect(placed.y).toBe(18);
    expect(placed.x + placed.width).toBeLessThanOrEqual(1366 - 18);
  });
});

describe('OSD state', () => {
  it('maps the active session, frame sample and temperatures', () => {
    const state = buildOsdState({
      status: STATUS,
      frame: FRAME,
      frameSource: 'etw',
      frameMessage: null,
      telemetry: TELEMETRY,
      nowMs: Date.parse('2026-01-01T00:10:00.000Z'),
    });

    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      profileName: 'Cyberpunk 2077',
      exe: 'Cyberpunk2077.exe',
      pid: 4242,
      elapsedMs: 600_000,
      fps: 118,
      low1Fps: 94,
      frameTimeMs: 8.5,
      cpuTempC: 71.4,
      gpuTempC: 64.8,
      powerDrawW: 182.3,
      applied: 2,
      skipped: 1,
      frameSource: 'etw',
      telemetryMessage: null,
    });
  });

  it('hides the state outside an active, fully applied session', () => {
    expect(
      buildOsdState({
        status: { ...STATUS, phase: 'launching' },
        frame: null,
        frameSource: 'etw',
        frameMessage: null,
        telemetry: null,
      }),
    ).toBeNull();

    expect(
      buildOsdState({
        status: { ...STATUS, phase: 'idle', active: null },
        frame: null,
        frameSource: 'etw',
        frameMessage: null,
        telemetry: null,
      }),
    ).toBeNull();
  });

  it('reports why frame telemetry is missing without fabricating values', () => {
    const state = buildOsdState({
      status: STATUS,
      frame: null,
      frameSource: 'unavailable',
      frameMessage: 'ETW session could not start.',
      telemetry: null,
      nowMs: Date.parse('2026-01-01T00:10:00.000Z'),
    });

    expect(state?.fps).toBeNull();
    expect(state?.low1Fps).toBeNull();
    expect(state?.frameSource).toBe('unavailable');
    expect(state?.frameMessage).toBe('ETW session could not start.');
    expect(state?.telemetryMessage).toBe('Hardware temperatures unavailable.');
  });
});

describe('OSD push coalescing', () => {
  const at = Date.parse('2026-01-01T00:10:00.000Z');
  const base = {
    status: STATUS,
    frame: FRAME,
    frameSource: 'etw',
    frameMessage: null,
    telemetry: TELEMETRY,
  } as const;

  it('treats two rebuilds inside the same second as one frame', () => {
    const first = buildOsdState({ ...base, nowMs: at });
    const second = buildOsdState({ ...base, nowMs: at + 400 });
    if (first === null || second === null) throw new Error('expected an active OSD state');

    // The timestamp moves, but nothing the overlay paints does: no re-render is needed.
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(osdStateKey(second)).toBe(osdStateKey(first));
  });

  it('changes the key when a painted value changes', () => {
    const first = buildOsdState({ ...base, nowMs: at });
    const second = buildOsdState({ ...base, frame: { ...FRAME, fps: 60 }, nowMs: at + 1_000 });
    if (first === null || second === null) throw new Error('expected an active OSD state');

    expect(osdStateKey(second)).not.toBe(osdStateKey(first));
  });
});

describe('ETW frame monitoring', () => {
  it('parses a valid sample and a valid status line', () => {
    expect(
      parseFrameMonitorLine(
        '{"type":"sample","fps":118.4,"low1Fps":94.2,"frameTimeMs":8.45,"frames":118,"at":"2026-01-01T00:00:00.000Z"}',
      ),
    ).toEqual({
      fps: 118.4,
      low1Fps: 94.2,
      frameTimeMs: 8.45,
      frames: 118,
      at: '2026-01-01T00:00:00.000Z',
    });

    expect(
      parseFrameMonitorLine('{"type":"status","state":"unavailable","message":"ETW needs elevation."}'),
    ).toEqual({ state: 'unavailable', message: 'ETW needs elevation.' });
  });

  it('rejects malformed evidence rather than passing it to the OSD', () => {
    expect(parseFrameMonitorLine('not json')).toBeNull();
    expect(parseFrameMonitorLine('{"type":"sample","fps":0}')).toBeNull();
    expect(parseFrameMonitorLine('{"type":"sample","fps":999999}')).toBeNull();
    expect(parseFrameMonitorLine('{"type":"status","state":"mystery"}')).toBeNull();
  });

  it('builds a static ETW script with only validated numeric substitutions', () => {
    const script = buildFrameMonitorScript(4242, 1000, 99);

    expect(script).toContain('DxgiProvider');
    expect(script).toContain('DxgiPresent = 42');
    expect(script).toContain('D3d9Present = 1');
    expect(script).toContain('Run(4242, 1000, 99)');
    expect(script).not.toContain('TARGET_PID');
    expect(() => buildFrameMonitorScript(0, 1000, 99)).toThrow(/positive process id/);
    expect(() => buildFrameMonitorScript(4242, 1000, -1)).toThrow(/positive parent process id/);
  });

  it('clamps the sample cadence to a sane range', () => {
    expect(clampFrameSampleMs(10)).toBe(500);
    expect(clampFrameSampleMs(999_999)).toBe(5000);
    expect(clampFrameSampleMs(Number.NaN)).toBe(1000);
  });
});

describe('watcher window geometry', () => {
  it('parses a foreground window rectangle and rejects impossible dimensions', () => {
    const parsed = parseForegroundLine(
      JSON.stringify({
        foreground: {
          pid: 100,
          exe: 'game.exe',
          path: 'C:\\Games\\game.exe',
          title: 'Game',
          packageFamilyName: 'Example.Game_8wekyb3d8bbwe',
        },
        window: { left: -1920, top: 0, width: 1920, height: 1080 },
      }),
    );
    expect(parsed?.window).toEqual({ left: -1920, top: 0, width: 1920, height: 1080 });
    expect(parsed?.foreground?.packageFamilyName).toBe('Example.Game_8wekyb3d8bbwe');

    const invalid = parseForegroundLine(
      JSON.stringify({
        foreground: { pid: 100, exe: 'game.exe' },
        window: { left: 0, top: 0, width: 0, height: 1080 },
      }),
    );
    expect(invalid?.window).toBeNull();

    const missing = parseForegroundLine(JSON.stringify({ foreground: null, window: null }));
    expect(missing).toEqual({ foreground: null, window: null });
  });

  it('builds an event-driven foreground script with no polling sleep', () => {
    const script = buildForegroundScript();

    expect(script).toContain('SetWinEventHook');
    expect(script).toContain('GetWindowRect');
    expect(script).toContain('EnableDpiAwareness');
    expect(script).not.toContain('Start-Sleep');
  });

  it('filters tasklist CSV output to watched image names', () => {
    const csv = [
      '"System Idle Process","0","Services","0","8 K"',
      '"game.exe","4242","Console","1","1,234,567 K"',
      '"chrome.exe","200","Console","1","100,000 K"',
      '"game.exe","777","Console","1","1,000 K"',
      '"not-a-game.exe","999","Console","1","1,000 K"',
      'not csv at all',
    ].join('\r\n');

    expect(parseTasklist(csv, ['game.exe', 'chrome.exe'])).toEqual([
      { pid: 200, exe: 'chrome.exe' },
      { pid: 777, exe: 'game.exe' },
      { pid: 4242, exe: 'game.exe' },
    ]);
  });
});
