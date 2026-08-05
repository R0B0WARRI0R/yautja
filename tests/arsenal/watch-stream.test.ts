import { describe, it, expect } from 'vitest';
import {
  computeStreamTick,
  buildStreamWatchScript,
  parseStreamWatchState,
  STREAM_WATCH_INITIAL,
  STREAM_WATCH_KEY,
} from '../../src/arsenal/watch-stream.js';

const T0 = 1000;

describe('computeStreamTick', () => {
  it('does not arm below minLength (stream not started)', () => {
    const s = computeStreamTick(STREAM_WATCH_INITIAL, 0, T0, 300, 1);
    expect(s.armed).toBe(false);
    expect(s.done).toBe(false);
  });

  it('arms once text reaches minLength, done stays false while changing', () => {
    const armed = computeStreamTick(STREAM_WATCH_INITIAL, 10, T0, 300, 1);
    expect(armed.armed).toBe(true);
    expect(armed.done).toBe(false);

    const grown = computeStreamTick(armed, 30, T0 + 100, 300, 1);
    expect(grown.done).toBe(false);
    expect(grown.lastChangeAt).toBe(T0 + 100);
  });

  it('done only after silenceMs without changes', () => {
    const armed = computeStreamTick(STREAM_WATCH_INITIAL, 10, T0, 300, 1);
    const beforeSilence = computeStreamTick(armed, 10, T0 + 200, 300, 1);
    expect(beforeSilence.done).toBe(false);
    const done = computeStreamTick(armed, 10, T0 + 400, 300, 1);
    expect(done.done).toBe(true);
  });

  it('a new chunk after done reopens the stream', () => {
    const armed = computeStreamTick(STREAM_WATCH_INITIAL, 10, T0, 100, 1);
    const done = computeStreamTick(armed, 10, T0 + 200, 100, 1);
    expect(done.done).toBe(true);
    const reopened = computeStreamTick(done, 20, T0 + 300, 100, 1);
    expect(reopened.done).toBe(false);
    expect(reopened.lastChangeAt).toBe(T0 + 300);
  });

  it('never settles at zero length when minLength >= 1', () => {
    const empty = computeStreamTick(STREAM_WATCH_INITIAL, 0, T0, 0, 1);
    expect(empty.done).toBe(false);
  });
});

describe('buildStreamWatchScript', () => {
  it('embeds config, tick source, the public key and a MutationObserver', () => {
    const script = buildStreamWatchScript({ selector: '#answer', silenceMs: 400, minLength: 5 });
    expect(script).toContain('#answer');
    expect(script).toContain('400');
    expect(script).toContain(STREAM_WATCH_KEY);
    expect(script).toContain('MutationObserver');
    expect(script).toContain('lastChangeAt');
    expect(script).toContain('document.body');
  });

  it('is idempotent via the observer guard', () => {
    const script = buildStreamWatchScript({ selector: '#answer', silenceMs: 400 });
    expect(script).toContain('__yautjaStreamObs');
  });
});

describe('parseStreamWatchState', () => {
  it('parses a valid flag', () => {
    const s = parseStreamWatchState({ armed: true, done: true, textLength: 512 });
    expect(s).toMatchObject({ armed: true, done: true, textLength: 512 });
  });

  it('returns null for garbage', () => {
    expect(parseStreamWatchState(null)).toBeNull();
    expect(parseStreamWatchState('nope')).toBeNull();
    expect(parseStreamWatchState(undefined)).toBeNull();
  });

  it('tolerates partial payloads', () => {
    const s = parseStreamWatchState({ armed: true });
    expect(s).toMatchObject({ armed: true, done: false, textLength: 0 });
  });
});