import { sha256 } from '@flow/simulator';

/** Versioned xorshift32; arithmetic is bitwise uint32, not financial arithmetic. */
export class Random {
  private state: number;
  constructor(seed: number, stream: string) {
    this.state =
      Number.parseInt(sha256(`phase2-v1:${seed}:${stream}`).slice(0, 8), 16) ||
      0x6d2b79f5;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  bigint(min: bigint, max: bigint): bigint {
    const width = max - min + 1n;
    if (width < 1n || width > 1n << 64n)
      throw new RangeError('Invalid random interval');
    const limit = (1n << 64n) - ((1n << 64n) % width);
    let draw: bigint;
    do {
      draw = (BigInt(this.next()) << 32n) | BigInt(this.next());
    } while (draw >= limit);
    return min + (draw % width);
  }
  integer(min: number, max: number): number {
    return Number(this.bigint(BigInt(min), BigInt(max)));
  }
  sample(size: number, count: number): number[] {
    if (count > size)
      throw new RangeError('Requested count exceeds eligible population');
    // Sparse Fisher-Yates: O(count) auxiliary memory when count is small.
    const swaps = new Map<number, number>();
    const result: number[] = [];
    for (let i = 0; i < count; i++) {
      const j = this.integer(i, size - 1);
      result.push(swaps.get(j) ?? j);
      swaps.set(j, swaps.get(i) ?? i);
    }
    return result;
  }
}
