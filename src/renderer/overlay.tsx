import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { OsdState } from '../shared/game/osd';
import { FloatRingBuffer } from '../shared/telemetry/ring-buffer';
import { TelemetryGraph } from './components/TelemetryGraph';
import './overlay.css';

const MOCK_STATE: OsdState = {
  profileName: 'Cyberpunk 2077',
  exe: 'Cyberpunk2077.exe',
  pid: 18472,
  startedAt: '2026-01-01T00:00:00.000Z',
  elapsedMs: 18 * 60 * 1000,
  fps: 118,
  low1Fps: 94,
  frameTimeMs: 8.5,
  cpuTempC: 71.4,
  gpuTempC: 64.8,
  powerDrawW: 182.3,
  applied: 4,
  skipped: 1,
  frameSource: 'etw',
  frameMessage: null,
  telemetryMessage: null,
  updatedAt: '2026-01-01T00:18:00.000Z',
};

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function valueOrDash(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

function temperature(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)}°`;
}

function Osd({ state, preview }: { state: OsdState; preview: boolean }): ReactNode {
  // Keep the last four minutes at the sampler's one-second cadence. The renderer is
  // independent of that cadence: it redraws at requestAnimationFrame speed and accepts
  // 100 Hz sources unchanged (the dashboard's live source uses this same buffer type).
  const frameHistory = useRef(new FloatRingBuffer(240));
  const lastSampleAt = useRef<string | null>(null);
  useEffect(() => {
    if (lastSampleAt.current === state.updatedAt) return;
    lastSampleAt.current = state.updatedAt;
    frameHistory.current.push(state.frameTimeMs ?? Number.NaN);
  }, [state.updatedAt, state.frameTimeMs]);
  const series = useMemo(
    () => [{ label: 'FRAME', color: '#d4ff5f', buffer: frameHistory.current }],
    [],
  );

  return (
    <div className="osd" aria-hidden="true">
      <div className="osd-head">
        <span className="osd-dot" />
        <span className="osd-live">TUNING ACTIVE</span>
        {preview && <span className="osd-preview">PREVIEW</span>}
        <span className="osd-elapsed">{formatElapsed(state.elapsedMs)}</span>
      </div>

      <div className="osd-profile" title={state.profileName}>
        {state.profileName}
      </div>
      <div className="osd-sub">
        {state.exe} · PID {state.pid}
      </div>

      <div className="osd-stats">
        <div className="osd-stat">
          <span className="osd-value">{valueOrDash(state.fps)}</span>
          <span className="osd-label">FPS</span>
        </div>
        <div className="osd-stat">
          <span className="osd-value osd-value-low">{valueOrDash(state.low1Fps)}</span>
          <span className="osd-label">1% LOW</span>
        </div>
        <div className="osd-stat">
          <span className="osd-value osd-value-ms">
            {state.frameTimeMs === null ? '—' : state.frameTimeMs.toFixed(1)}
          </span>
          <span className="osd-label">MS</span>
        </div>
      </div>

      <TelemetryGraph series={series} height={50} unit="ms" className="osd-graph" />

      <div className="osd-foot">
        <span>
          CPU {temperature(state.cpuTempC)} · GPU {temperature(state.gpuTempC)}
          {state.powerDrawW !== null ? ` · ${state.powerDrawW.toFixed(0)} W` : ''}
        </span>
        <span className={state.frameSource === 'etw' ? 'osd-source' : 'osd-source osd-source-off'}>
          {state.frameSource === 'etw' ? 'ETW' : 'NO ETW'}
        </span>
      </div>

      <div className="osd-note">
        {state.frameMessage ?? state.telemetryMessage ?? `${state.applied} applied · ${state.skipped} skipped · no injection`}
      </div>
    </div>
  );
}

function App(): ReactNode {
  const [state, setState] = useState<OsdState | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    const bridge = window.tunesmithOsd;
    if (bridge !== undefined) return bridge.onState(setState);

    // Browser preview only. The transplanted state lets the transparent layout be
    // inspected without an Electron window or a running game.
    setPreview(true);
    setState(MOCK_STATE);
    return undefined;
  }, []);

  if (state === null) {
    return (
      <div className="osd osd-empty" aria-hidden="true">
        <span className="osd-dot" />
        Waiting for an active game profile…
      </div>
    );
  }

  return <Osd state={state} preview={preview} />;
}

const host = document.getElementById('osd-root');
if (host === null) throw new Error('OSD root element is missing');
createRoot(host).render(<App />);
