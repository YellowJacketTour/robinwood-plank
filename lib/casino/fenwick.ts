/** Exact BigInt Fenwick tree used as a model for Solidity prefix accounting. */
export class Fenwick {
  readonly size: number;
  readonly tree: bigint[];

  constructor(size: number) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new RangeError("invalid Fenwick size");
    this.size = size;
    this.tree = Array<bigint>(size + 1).fill(0n);
  }

  add(index: number, delta: bigint): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.size) throw new RangeError("index out of range");
    for (let cursor = index + 1; cursor <= this.size; cursor += cursor & -cursor) {
      const next = this.tree[cursor] + delta;
      if (next < 0n) throw new RangeError("Fenwick underflow");
      this.tree[cursor] = next;
    }
  }

  prefix(index: number): bigint {
    if (index < 0) return 0n;
    if (!Number.isSafeInteger(index) || index >= this.size) throw new RangeError("index out of range");
    let sum = 0n;
    for (let cursor = index + 1; cursor > 0; cursor -= cursor & -cursor) sum += this.tree[cursor];
    return sum;
  }

  at(index: number): bigint {
    return this.prefix(index) - this.prefix(index - 1);
  }
}
