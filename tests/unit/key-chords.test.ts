import { describe, it, expect } from 'vitest';
import { buildKeySequence } from '../../src/arsenal/key-chords.js';

describe('buildKeySequence', () => {
  describe('single keys', () => {
    it('letter produces text keyDown + keyUp', () => {
      const ev = buildKeySequence('a');
      expect(ev).toEqual([
        { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a', unmodifiedText: 'a' },
        { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0 },
      ]);
    });

    it('Enter is a non-text key (rawKeyDown, no text)', () => {
      const ev = buildKeySequence('Enter');
      expect(ev).toHaveLength(2);
      expect(ev[0]).toMatchObject({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 });
      expect(ev[0]!.text).toBeUndefined();
      expect(ev[1]).toMatchObject({ type: 'keyUp', key: 'Enter', modifiers: 0 });
    });

    it('digit produces text', () => {
      const ev = buildKeySequence('5');
      expect(ev[0]).toMatchObject({ type: 'keyDown', key: '5', code: 'Digit5', windowsVirtualKeyCode: 53, text: '5' });
    });

    it('symbol produces text with US vk', () => {
      const ev = buildKeySequence('/');
      expect(ev[0]).toMatchObject({ type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' });
    });

    it('F-keys and navigation keys are non-text', () => {
      for (const [key, code, vk] of [
        ['F5', 'F5', 116],
        ['Home', 'Home', 36],
        ['PageDown', 'PageDown', 34],
        ['ArrowLeft', 'ArrowLeft', 37],
        ['Tab', 'Tab', 9],
        ['Escape', 'Escape', 27],
      ] as const) {
        const ev = buildKeySequence(key);
        expect(ev[0]).toMatchObject({ type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
        expect(ev[0]!.text).toBeUndefined();
      }
    });
  });

  describe('chords', () => {
    it('ctrl+v: modifier down first, no text on main key (Ctrl active)', () => {
      const ev = buildKeySequence('ctrl+v');
      expect(ev.map((e) => `${e.type}:${e.key}:${e.modifiers}`)).toEqual([
        'rawKeyDown:Control:2',
        'rawKeyDown:v:2',
        'keyUp:v:2',
        'keyUp:Control:0',
      ]);
      expect(ev[1]!.text).toBeUndefined();
      expect(ev[1]!.code).toBe('KeyV');
      expect(ev[1]!.windowsVirtualKeyCode).toBe(86);
    });

    it('ctrl+shift+t: full sequence with accumulating/clearing bitfield', () => {
      const ev = buildKeySequence('ctrl+shift+t');
      expect(ev.map((e) => `${e.type}:${e.key}:${e.modifiers}`)).toEqual([
        'rawKeyDown:Control:2',
        'rawKeyDown:Shift:10',
        'rawKeyDown:t:10',
        'keyUp:t:10',
        'keyUp:Shift:2',
        'keyUp:Control:0',
      ]);
      expect(ev[2]!.text).toBeUndefined();
    });

    it('shift+a produces uppercase text (no Ctrl/Meta)', () => {
      const ev = buildKeySequence('shift+a');
      expect(ev[1]).toMatchObject({
        type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65,
        modifiers: 8, text: 'A', unmodifiedText: 'a',
      });
    });

    it('modifiers object ORs with chord modifiers', () => {
      const ev = buildKeySequence('ctrl+t', { shift: true });
      expect(ev.map((e) => e.key)).toEqual(['Control', 'Shift', 't', 't', 'Shift', 'Control']);
      expect(ev[2]!.modifiers).toBe(10);
    });

    it('modifiers object alone works (back-compat)', () => {
      const ev = buildKeySequence('a', { ctrl: true });
      expect(ev.map((e) => `${e.type}:${e.key}:${e.modifiers}`)).toEqual([
        'rawKeyDown:Control:2',
        'rawKeyDown:a:2',
        'keyUp:a:2',
        'keyUp:Control:0',
      ]);
    });

    it('meta is bit 4 and suppresses text', () => {
      const ev = buildKeySequence('cmd+l');
      expect(ev[0]).toMatchObject({ key: 'Meta', modifiers: 4 });
      expect(ev[1]).toMatchObject({ type: 'rawKeyDown', key: 'l', modifiers: 4 });
      expect(ev[1]!.text).toBeUndefined();
    });
  });

  describe('case-insensitivity and aliases', () => {
    it('modifier names are case-insensitive', () => {
      expect(buildKeySequence('Control+V')).toEqual(buildKeySequence('ctrl+v'));
      expect(buildKeySequence('CTRL+SHIFT+T')).toEqual(buildKeySequence('ctrl+shift+t'));
    });

    it('accepts option/command/win aliases', () => {
      expect(buildKeySequence('option+a')[0]!.key).toBe('Alt');
      expect(buildKeySequence('command+a')[0]!.key).toBe('Meta');
      expect(buildKeySequence('win+a')[0]!.key).toBe('Meta');
    });

    it('named keys are case-insensitive with aliases', () => {
      expect(buildKeySequence('enter')[0]!.key).toBe('Enter');
      expect(buildKeySequence('Return')[0]!.key).toBe('Enter');
      expect(buildKeySequence('esc')[0]!.key).toBe('Escape');
      expect(buildKeySequence('space')[0]!).toMatchObject({ code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
      expect(buildKeySequence('LEFT')[0]!.key).toBe('ArrowLeft');
    });
  });

  describe('lone modifier', () => {
    it('press "Control" alone is a simple press/release', () => {
      const ev = buildKeySequence('Control');
      expect(ev).toEqual([
        { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 },
        { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 },
      ]);
    });
  });

  describe('errors', () => {
    it('unknown key throws naming the key', () => {
      expect(() => buildKeySequence('Foosball')).toThrow(/Unknown key "Foosball"/);
    });

    it('unknown key inside a chord throws', () => {
      expect(() => buildKeySequence('ctrl+banana')).toThrow(/Unknown key "banana"/);
    });

    it('multiple non-modifier keys throw', () => {
      expect(() => buildKeySequence('a+b')).toThrow(/multiple non-modifier keys/);
    });

    it('only modifiers (multi) throw', () => {
      expect(() => buildKeySequence('ctrl+shift')).toThrow(/no main key/);
    });
  });
});
