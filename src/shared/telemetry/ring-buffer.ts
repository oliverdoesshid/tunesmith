/**
 * Fixed-capacity telemetry ring buffer.
 *
 * Collection happens at 100 Hz or faster, so the hot path must not allocate. A single
 * `Float32Array` is allocated at construction, then rewritten in place: no array growth,
 * no `shift()`, no per-sample objects. Renderers iterate with `forEach`/`at` and never
 * receive a copied array.
 */
export class FloatRingBuffer {
  readonly capacity: number;
  private readonly values: Float32Array;
  private writeIndex = 0;
  private count = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 16_384) {
      throw new RangeError('Ring buffer capacity must be an integer between 2 and 16384.');
    }
    this.capacity = capacity;
    this.values = new Float32Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Append one sample. NaN is preserved as a visual gap rather than dropped. */
  push(value: number): void {
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Oldest-to-newest index access. Returns null when outside the live window. */
  at(index: number): number | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return null;
    const start = (this.writeIndex - this.count + this.capacity) % this.capacity;
    return this.values[(start + index) % this.capacity] ?? null;
  }

  latest(): number | null {
    return this.count === 0 ? null : this.at(this.count - 1);
  }

  /** Oldest-to-newest iteration; the callback is synchronous and called in place. */
  forEach(visit: (value: number, index: number) => void): void {
    const start = (this.writeIndex - this.count + this.capacity) % this.capacity;
    for (let index = 0; index < this.count; index += 1) {
      visit(this.values[(start + index) % this.capacity] ?? Number.NaN, index);
    }
  }

  clear(): void {
    this.writeIndex = 0;
    this.count = 0;
  }
}
