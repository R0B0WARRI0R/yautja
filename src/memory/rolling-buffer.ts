export class RollingBuffer<T> {
  private readonly backing: Array<T | undefined>;
  private head: number = 0;
  private count: number = 0;

  constructor(public readonly maxSize: number) {
    if (!Number.isFinite(maxSize) || !Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError(`RollingBuffer: maxSize must be a positive integer, got ${maxSize}`);
    }
    this.backing = new Array<T | undefined>(maxSize);
  }

  push(item: T): T | undefined {
    if (this.count === this.maxSize) {
      const evicted = this.backing[this.head];
      this.backing[this.head] = item;
      this.head = (this.head + 1) % this.maxSize;
      return evicted;
    }
    const tail = (this.head + this.count) % this.maxSize;
    this.backing[tail] = item;
    this.count++;
    return undefined;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.backing[this.head];
  }

  last(): T | undefined {
    if (this.count === 0) return undefined;
    const tailIdx = (this.head + this.count - 1) % this.maxSize;
    return this.backing[tailIdx];
  }

  get length(): number {
    return this.count;
  }

  get capacity(): number {
    return this.maxSize;
  }

  isFull(): boolean {
    return this.count === this.maxSize;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const item = this.backing[this.head];
    this.backing[this.head] = undefined;
    this.head = (this.head + 1) % this.maxSize;
    this.count--;
    return item;
  }

  clear(): void {
    for (let i = 0; i < this.maxSize; i++) {
      this.backing[i] = undefined;
    }
    this.head = 0;
    this.count = 0;
  }

  toArray(): T[] {
    const result: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.backing[(this.head + i) % this.maxSize] as T;
    }
    return result;
  }

  filter(predicate: (item: T, index: number) => boolean): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.backing[(this.head + i) % this.maxSize] as T;
      if (predicate(item, i)) result.push(item);
    }
    return result;
  }

  find(predicate: (item: T, index: number) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const item = this.backing[(this.head + i) % this.maxSize] as T;
      if (predicate(item, i)) return item;
    }
    return undefined;
  }

  forEach(fn: (item: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const item = this.backing[(this.head + i) % this.maxSize] as T;
      fn(item, i);
    }
  }
}