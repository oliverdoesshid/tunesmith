/**
 * React 19 wrapper around the imperative canvas renderer.
 *
 * React never sees the sample stream: it renders the frame, attaches observers, and
 * updates only the hover tooltip. The canvas loop runs on requestAnimationFrame with no
 * component state changes, so a 144 Hz display does not imply 144 React renders.
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { TelemetryChart, type TelemetryHover, type TelemetrySeries } from '../lib/telemetry-chart';

export interface TelemetryGraphProps {
  series: readonly TelemetrySeries[];
  height?: number;
  unit?: string;
  maxValue?: number;
  variant?: 'line' | 'bars';
  className?: string;
}

export function TelemetryGraph({
  series,
  height = 64,
  unit,
  maxValue,
  variant = 'line',
  className,
}: TelemetryGraphProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<TelemetryChart | null>(null);
  const [hover, setHover] = useState<TelemetryHover | null>(null);
  const [hoverX, setHoverX] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const chart = new TelemetryChart(canvas, { series, unit, maxValue, variant });
    chartRef.current = chart;

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      chart.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    resize();
    chart.start();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    window.addEventListener('resize', resize);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [series, unit, maxValue, variant]);

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const chart = chartRef.current;
    const canvas = canvasRef.current;
    if (chart === null || canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (chart.indexAt(x) === null) return;
    setHoverX(x);
    setHover(chart.hoverAt(x));
  };

  const onPointerLeave = (): void => {
    setHover(null);
  };

  return (
    <div className={`telemetry-graph ${className ?? ''}`} style={{ height }}>
      <canvas
        ref={canvasRef}
        className="telemetry-graph-canvas"
        role="img"
        aria-label={`Telemetry graph with ${String(series.length)} series`}
      />
      <div
        className="telemetry-graph-hit"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      />
      {hover !== null && (
        <div
          className="telemetry-tooltip"
          style={{ left: `${String(Math.min(hoverX + 8, 260))}px` } as CSSProperties}
          role="status"
        >
          {hover.values.map((entry) => (
            <span key={entry.label} style={{ color: entry.color }}>
              {entry.label}: {entry.value === null || Number.isNaN(entry.value) ? '—' : entry.value.toFixed(1)}
              {unit ?? ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
