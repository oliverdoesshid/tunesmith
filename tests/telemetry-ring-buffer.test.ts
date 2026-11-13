import { describe, expect, it } from 'vitest';
import { FloatRingBuffer } from '../src/shared/telemetry/ring-buffer';

describe('FloatRingBuffer', () => {
  it('keeps the newest samples after wrapping', () => {
    const buffer = new FloatRingBuffer(4);
    for (const value of [10, 20, 30, 40, 50, 60]) buffer.push(value);

    expect(buffer.length).toBe(4);
    expect(buffer.latest()).toBe(60);
    expect(buffer.at(0)).toBe(30);
    expect(buffer.at(1)).toBe(40);
    expect(buffer.at(2)).toBe(50);
    expect(buffer.at(3)).toBe(60);
    expect(buffer.at(4)).toBeNull();
  });

  it('iterates oldest-to-newest without copying', () => {
    const buffer = new FloatRingBuffer(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    const seen: number[] = [];
    buffer.forEach((value, index) => {
      expect(index).toBe(seen.length);
      seen.push(value);
    });
    expect(seen).toEqual([2, 3, 4]);
  });

  it('preserves NaN as a gap and clears safely', () => {
    const buffer = new FloatRingBuffer(2);
    buffer.push(Number.NaN);
    buffer.push(12);
    expect(buffer.at(0)).toBeNaN();
    expect(buffer.latest()).toBe(12);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.latest()).toBeNull();
  });

  it('rejects unsafe capacities', () => {
    expect(() => new FloatRingBuffer(1)).toThrow(RangeError);
    expect(() => new FloatRingBuffer(20_000)).toThrow(RangeError);
  });
});
