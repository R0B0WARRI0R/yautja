import { describe, it, expect } from 'vitest';
import { RollingBuffer } from '../../src/memory/rolling-buffer.js';

describe('RollingBuffer', () => {
  describe('constructor', () => {
    it('stores maxSize as capacity', () => {
      const buf = new RollingBuffer<number>(5);
      expect(buf.capacity).toBe(5);
      expect(buf.length).toBe(0);
    });

    it('throws RangeError on zero', () => {
      expect(() => new RollingBuffer<number>(0)).toThrow(RangeError);
    });

    it('throws RangeError on negative', () => {
      expect(() => new RollingBuffer<number>(-1)).toThrow(RangeError);
    });

    it('throws RangeError on NaN', () => {
      expect(() => new RollingBuffer<number>(Number.NaN)).toThrow(RangeError);
    });

    it('throws RangeError on non-integer', () => {
      expect(() => new RollingBuffer<number>(2.5)).toThrow(RangeError);
    });
  });

  describe('push', () => {
    it('adds items and returns undefined when not full', () => {
      const buf = new RollingBuffer<number>(3);
      expect(buf.push(1)).toBeUndefined();
      expect(buf.push(2)).toBeUndefined();
      expect(buf.push(3)).toBeUndefined();
      expect(buf.length).toBe(3);
    });

    it('evicts oldest and returns evicted item when full', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.push(4)).toBe(1);
      expect(buf.push(5)).toBe(2);
      expect(buf.toArray()).toEqual([3, 4, 5]);
    });

    it('capacity of 1 evicts on every push', () => {
      const buf = new RollingBuffer<string>(1);
      expect(buf.push('a')).toBeUndefined();
      expect(buf.push('b')).toBe('a');
      expect(buf.push('c')).toBe('b');
      expect(buf.toArray()).toEqual(['c']);
    });
  });

  describe('peek', () => {
    it('returns oldest without removing', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.peek()).toBe(10);
      expect(buf.length).toBe(3);
      expect(buf.peek()).toBe(10);
    });

    it('returns undefined when empty', () => {
      const buf = new RollingBuffer<number>(3);
      expect(buf.peek()).toBeUndefined();
    });

    it('returns oldest even after eviction', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      expect(buf.peek()).toBe(2);
    });
  });

  describe('last', () => {
    it('returns newest without removing', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.last()).toBe(30);
      expect(buf.length).toBe(3);
    });

    it('returns undefined when empty', () => {
      const buf = new RollingBuffer<number>(3);
      expect(buf.last()).toBeUndefined();
    });

    it('tracks newest after evictions', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect(buf.last()).toBe(5);
    });
  });

  describe('length', () => {
    it('tracks correctly through pushes and shifts', () => {
      const buf = new RollingBuffer<number>(4);
      expect(buf.length).toBe(0);
      buf.push(1);
      expect(buf.length).toBe(1);
      buf.push(2);
      buf.push(3);
      expect(buf.length).toBe(3);
      buf.shift();
      buf.shift();
      expect(buf.length).toBe(1);
    });

    it('does not grow beyond capacity', () => {
      const buf = new RollingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect(buf.length).toBe(2);
    });
  });

  describe('capacity', () => {
    it('returns maxSize', () => {
      expect(new RollingBuffer<number>(7).capacity).toBe(7);
      expect(new RollingBuffer<number>(100).capacity).toBe(100);
    });
  });

  describe('isFull / isEmpty', () => {
    it('isEmpty true initially', () => {
      const buf = new RollingBuffer<number>(3);
      expect(buf.isEmpty()).toBe(true);
      expect(buf.isFull()).toBe(false);
    });

    it('isFull true at capacity', () => {
      const buf = new RollingBuffer<number>(2);
      buf.push(1);
      expect(buf.isFull()).toBe(false);
      buf.push(2);
      expect(buf.isFull()).toBe(true);
      expect(buf.isEmpty()).toBe(false);
    });

    it('stays full while over capacity (no growth)', () => {
      const buf = new RollingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      expect(buf.isFull()).toBe(true);
    });
  });

  describe('shift', () => {
    it('removes and returns oldest', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.shift()).toBe(10);
      expect(buf.length).toBe(2);
      expect(buf.shift()).toBe(20);
      expect(buf.shift()).toBe(30);
      expect(buf.length).toBe(0);
    });

    it('returns undefined when empty', () => {
      const buf = new RollingBuffer<number>(3);
      expect(buf.shift()).toBeUndefined();
    });

    it('still evicts on push after draining', () => {
      const buf = new RollingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.shift();
      buf.push(3);
      buf.push(4);
      expect(buf.shift()).toBe(3);
      expect(buf.shift()).toBe(4);
    });
  });

  describe('clear', () => {
    it('empties the buffer', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.clear();
      expect(buf.length).toBe(0);
      expect(buf.isEmpty()).toBe(true);
      expect(buf.peek()).toBeUndefined();
      expect(buf.last()).toBeUndefined();
    });

    it('allows reuse after clear', () => {
      const buf = new RollingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.clear();
      buf.push(99);
      expect(buf.toArray()).toEqual([99]);
      expect(buf.push(100)).toBeUndefined();
      expect(buf.push(101)).toBe(99);
    });
  });

  describe('toArray', () => {
    it('returns snapshot oldest to newest', () => {
      const buf = new RollingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      expect(buf.toArray()).toEqual([1, 2, 3]);
    });

    it('preserves order after evictions', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      expect(buf.toArray()).toEqual([3, 4, 5]);
    });

    it('returns empty array when empty', () => {
      expect(new RollingBuffer<number>(3).toArray()).toEqual([]);
    });

    it('mutation of returned array does not affect buffer', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      const snap = buf.toArray();
      snap[0] = 999;
      snap.push(123);
      expect(buf.toArray()).toEqual([1, 2, 3]);
      expect(buf.length).toBe(3);
    });
  });

  describe('filter', () => {
    it('returns matching items in order', () => {
      const buf = new RollingBuffer<number>(5);
      for (let i = 1; i <= 5; i++) buf.push(i);
      const evens = buf.filter((n) => n % 2 === 0);
      expect(evens).toEqual([2, 4]);
    });

    it('returns empty array when nothing matches', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.filter((n) => n > 100)).toEqual([]);
    });

    it('passes index to predicate', () => {
      const buf = new RollingBuffer<string>(3);
      buf.push('a');
      buf.push('b');
      buf.push('c');
      const collected: Array<[string, number]> = [];
      buf.filter((item, i) => {
        collected.push([item, i]);
        return true;
      });
      expect(collected).toEqual([
        ['a', 0],
        ['b', 1],
        ['c', 2],
      ]);
    });
  });

  describe('find', () => {
    it('returns first match', () => {
      const buf = new RollingBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      expect(buf.find((n) => n > 15)).toBe(20);
    });

    it('returns undefined when no match', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      expect(buf.find((n) => n > 100)).toBeUndefined();
    });
  });

  describe('forEach', () => {
    it('iterates in order oldest to newest', () => {
      const buf = new RollingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      const seen: number[] = [];
      buf.forEach((n) => seen.push(n));
      expect(seen).toEqual([1, 2, 3]);
    });

    it('passes index', () => {
      const buf = new RollingBuffer<string>(2);
      buf.push('x');
      buf.push('y');
      const collected: Array<[string, number]> = [];
      buf.forEach((item, i) => collected.push([item, i]));
      expect(collected).toEqual([
        ['x', 0],
        ['y', 1],
      ]);
    });

    it('does nothing on empty buffer', () => {
      const buf = new RollingBuffer<number>(3);
      let count = 0;
      buf.forEach(() => count++);
      expect(count).toBe(0);
    });
  });

  describe('generic', () => {
    it('works with objects', () => {
      interface Event {
        id: number;
        name: string;
      }
      const buf = new RollingBuffer<Event>(2);
      buf.push({ id: 1, name: 'a' });
      buf.push({ id: 2, name: 'b' });
      buf.push({ id: 3, name: 'c' });
      const arr = buf.toArray();
      expect(arr).toEqual([
        { id: 2, name: 'b' },
        { id: 3, name: 'c' },
      ]);
      expect(arr[0]?.name).toBe('b');
    });

    it('works with strings', () => {
      const buf = new RollingBuffer<string>(2);
      buf.push('foo');
      buf.push('bar');
      expect(buf.last()).toBe('bar');
    });

    it('handles wrap-around correctly across many pushes', () => {
      const buf = new RollingBuffer<number>(4);
      for (let i = 0; i < 100; i++) buf.push(i);
      expect(buf.toArray()).toEqual([96, 97, 98, 99]);
      expect(buf.peek()).toBe(96);
      expect(buf.last()).toBe(99);
    });
  });
});