/**
 * Allocation-conscious Canvas 2D telemetry renderer.
 *
 * The hot loop reads the fixed Float32Array ring buffers and draws with a persistent
 * context. No per-frame arrays, gradients or cloned sample objects are created. React
 * owns only the hover tooltip, which updates on pointer movement rather than per frame.
 */
import type { FloatRingBuffer } from '../../shared/telemetry/ring-buffer';

export interface TelemetrySeries {
  label: string;
  color: string;
  buffer: FloatRingBuffer;
}

export interface TelemetryChartOptions {
  series: readonly TelemetrySeries[];
  unit?: string;
  /** Optional fixed upper bound; otherwise the renderer expands to the live maximum. */
  maxValue?: number;
  variant?: 'line' | 'bars';
}

export interface TelemetryHover {
  /** Oldest-to-newest index shared by the longest series. */
  index: number;
  values: { label: string; color: string; value: number | null }[];
}

const PADDING = { left: 34, right: 8, top: 10, bottom: 16 } as const;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class TelemetryChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly options: TelemetryChartOptions;
  private readonly series: readonly TelemetrySeries[];
  private raf: number | null = null;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: TelemetryChartOptions) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (ctx === null) throw new Error('Canvas 2D is unavailable in this renderer.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.options = options;
    this.series = options.series;
    this.resize(1, 1, 1);
  }

  /** Called by the React wrapper after CSS size or devicePixelRatio changes. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(1, Math.round(cssWidth));
    this.cssHeight = Math.max(1, Math.round(cssHeight));
    this.dpr = clamp(dpr, 1, 3);
    const pixelWidth = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const pixelHeight = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  start(): void {
    if (this.raf !== null || this.disposed) return;
    const loop = (): void => {
      if (this.disposed) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Map a CSS-pixel x coordinate to the oldest-to-newest sample index. */
  indexAt(cssX: number): number | null {
    const maxLength = this.maxLength();
    if (maxLength === 0) return null;
    const plotWidth = Math.max(1, this.cssWidth - PADDING.left - PADDING.right);
    const relative = clamp(cssX - PADDING.left, 0, plotWidth);
    return Math.min(maxLength - 1, Math.floor((relative / plotWidth) * maxLength));
  }

  hoverAt(cssX: number): TelemetryHover | null {
    const index = this.indexAt(cssX);
    if (index === null) return null;
    const maxLength = this.maxLength();
    const age = maxLength - 1 - index;
    const values: TelemetryHover['values'] = [];
    for (const entry of this.series) {
      const localIndex = entry.buffer.length - 1 - age;
      values.push({ label: entry.label, color: entry.color, value: entry.buffer.at(localIndex) });
    }
    return { index, values };
  }

  private maxLength(): number {
    let max = 0;
    for (const entry of this.series) max = Math.max(max, entry.buffer.length);
    return max;
  }

  private draw(): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const width = this.cssWidth;
    const height = this.cssHeight;
    ctx.clearRect(0, 0, width, height);
    const plotLeft = PADDING.left;
    const plotTop = PADDING.top;
    const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
    const plotHeight = Math.max(1, height - PADDING.top - PADDING.bottom);

    ctx.save();
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    let maxValue = this.options.maxValue ?? 0;
    for (const entry of this.series) {
      const length = entry.buffer.length;
      for (let index = 0; index < length; index += 1) {
        const value = entry.buffer.at(index);
        if (value !== null && Number.isFinite(value) && value > maxValue) maxValue = value;
      }
    }
    if (!Number.isFinite(maxValue) || maxValue <= 0) maxValue = 1;
    maxValue = Math.ceil(maxValue * 1.15);
    if (this.options.maxValue !== undefined) maxValue = this.options.maxValue;

    // Horizontal rules and fixed-axis labels. Four rules are enough for a compact OSD.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    for (let line = 0; line <= 4; line += 1) {
      const y = plotTop + (plotHeight / 4) * line;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotWidth, y);
      ctx.stroke();
      const value = maxValue * (1 - line / 4);
      ctx.fillText(this.options.unit === undefined ? value.toFixed(0) : `${value.toFixed(value < 10 ? 1 : 0)}${this.options.unit}`, 2, y);
    }

    if (this.maxLength() === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('Waiting for samples…', plotLeft + 4, plotTop + plotHeight / 2);
      ctx.restore();
      return;
    }

    const variant = this.options.variant ?? 'line';
    for (const entry of this.series) {
      const length = entry.buffer.length;
      if (length === 0) continue;
      ctx.strokeStyle = entry.color;
      ctx.fillStyle = entry.color;
      if (variant === 'bars') {
        const barWidth = Math.max(1, plotWidth / length);
        for (let index = 0; index < length; index += 1) {
          const value = entry.buffer.at(index);
          if (value === null || !Number.isFinite(value)) continue;
          const barHeight = clamp((value / maxValue) * plotHeight, 0, plotHeight);
          ctx.fillRect(plotLeft + index * barWidth, plotTop + plotHeight - barHeight, Math.max(1, barWidth - 1), barHeight);
        }
        continue;
      }

      ctx.beginPath();
      let drawing = false;
      for (let index = 0; index < length; index += 1) {
        const value = entry.buffer.at(index);
        if (value === null || !Number.isFinite(value)) {
          drawing = false;
          continue;
        }
        const x = plotLeft + (index / Math.max(1, length - 1)) * plotWidth;
        const y = plotTop + plotHeight - clamp((value / maxValue) * plotHeight, 0, plotHeight);
        if (drawing) ctx.lineTo(x, y);
        else {
          ctx.moveTo(x, y);
          drawing = true;
        }
      }
      ctx.stroke();
    }

    // Live last-value labels; the text length is bounded by the numeric format.
    let labelY = plotTop + 7;
    for (const entry of this.series) {
      const latest = entry.buffer.latest();
      if (latest === null) continue;
      ctx.fillStyle = entry.color;
      ctx.fillText(`${entry.label} ${latest.toFixed(1)}`, plotLeft + 4, labelY);
      labelY += 11;
    }
    ctx.restore();
  }
}
