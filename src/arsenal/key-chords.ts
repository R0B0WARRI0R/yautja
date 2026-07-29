/**
 * Key chord parser (quick win — RE de Claude in Chrome).
 *
 * Parses a `press` key spec ("ctrl+v", "Control+Home", "ctrl+shift+t",
 * "a", "Enter") into the ordered `Input.dispatchKeyEvent` sequence Chrome
 * actually honours:
 *
 *   keyDown(modifiers...) → keyDown(main) → keyUp(main) → keyUp(modifiers reversed)
 *
 * Every event carries `key`, `code`, `windowsVirtualKeyCode` and the CDP
 * modifier bitfield (Alt=1, Ctrl=2, Meta=4, Shift=8). Text-producing keys
 * (single printable chars, no Ctrl/Meta) go down as `keyDown` with `text`
 * and `unmodifiedText`; non-text keys use `rawKeyDown` without `text`.
 *
 * Pure and side-effect free so it is unit-testable.
 */

export interface PressModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface KeyEventParams {
  type: 'keyDown' | 'keyUp' | 'rawKeyDown';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
}

// CDP modifier bitfield
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

type ModifierName = 'ctrl' | 'shift' | 'alt' | 'meta';

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  /** Base character the key produces without modifiers (letters lowercase). */
  text?: string;
}

const MODIFIER_DEFS: Record<ModifierName, { def: KeyDef; bit: number }> = {
  ctrl: { def: { key: 'Control', code: 'ControlLeft', vk: 17 }, bit: MOD_CTRL },
  shift: { def: { key: 'Shift', code: 'ShiftLeft', vk: 16 }, bit: MOD_SHIFT },
  alt: { def: { key: 'Alt', code: 'AltLeft', vk: 18 }, bit: MOD_ALT },
  meta: { def: { key: 'Meta', code: 'MetaLeft', vk: 91 }, bit: MOD_META },
};

// Deterministic order for modifier keyDown (reversed on keyUp).
const MODIFIER_ORDER: ModifierName[] = ['ctrl', 'shift', 'alt', 'meta'];

const MODIFIER_NAMES: Record<string, ModifierName> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
};

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13 },
  return: { key: 'Enter', code: 'Enter', vk: 13 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pgup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  pgdn: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

// Single printable characters (US layout): letters, digits, space, symbols.
const CHAR_KEYS: Record<string, KeyDef> = {};
for (let i = 0; i < 26; i++) {
  const letter = String.fromCharCode(97 + i); // a-z
  CHAR_KEYS[letter] = {
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    vk: 65 + i,
    text: letter,
  };
}
for (let i = 0; i <= 9; i++) {
  CHAR_KEYS[String(i)] = { key: String(i), code: `Digit${i}`, vk: 48 + i, text: String(i) };
}
CHAR_KEYS[' '] = { key: ' ', code: 'Space', vk: 32, text: ' ' };
NAMED_KEYS['space'] = CHAR_KEYS[' ']!;
NAMED_KEYS['spacebar'] = CHAR_KEYS[' ']!;

const SYMBOL_DEFS: [string, string, number][] = [
  ['-', 'Minus', 189],
  ['=', 'Equal', 187],
  ['[', 'BracketLeft', 219],
  [']', 'BracketRight', 221],
  ['\\', 'Backslash', 220],
  [';', 'Semicolon', 186],
  ["'", 'Quote', 222],
  [',', 'Comma', 188],
  ['.', 'Period', 190],
  ['/', 'Slash', 191],
  ['`', 'Backquote', 192],
];
for (const [char, code, vk] of SYMBOL_DEFS) {
  CHAR_KEYS[char] = { key: char, code, vk, text: char };
}

function resolveMainKey(part: string, chord: string): KeyDef {
  const def =
    part.length === 1
      ? CHAR_KEYS[part.toLowerCase()]
      : NAMED_KEYS[part.toLowerCase()];
  if (!def) {
    throw new Error(
      `Unknown key "${part}" in chord "${chord}": not in the key table ` +
        '(a-z, 0-9, F1-F12, Enter, Tab, Escape, Backspace, Delete, arrows, ' +
        'Home/End, PageUp/PageDown, Space, US symbols -=[]\\;\',./`)',
    );
  }
  return def;
}

/**
 * Builds the ordered CDP event sequence for a chord. Modifier flags from
 * the chord string and the `modifiers` object are OR-ed together.
 * Throws on unknown keys or malformed chords.
 */
export function buildKeySequence(key: string, modifiers?: PressModifiers): KeyEventParams[] {
  const parts = key
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const flags: Record<ModifierName, boolean> = {
    ctrl: !!modifiers?.ctrl,
    shift: !!modifiers?.shift,
    alt: !!modifiers?.alt,
    meta: !!modifiers?.meta,
  };

  let mainPart: string | null = null;
  for (const part of parts) {
    const mod = MODIFIER_NAMES[part.toLowerCase()];
    if (mod) {
      flags[mod] = true;
    } else if (mainPart !== null) {
      throw new Error(
        `Invalid chord "${key}": multiple non-modifier keys ("${mainPart}", "${part}")`,
      );
    } else {
      mainPart = part;
    }
  }

  // A lone modifier name ("Control") is a simple press/release of that key.
  if (mainPart === null) {
    if (parts.length === 1) {
      const modDef = MODIFIER_DEFS[MODIFIER_NAMES[parts[0]!.toLowerCase()]!].def;
      return [
        { type: 'rawKeyDown', key: modDef.key, code: modDef.code, windowsVirtualKeyCode: modDef.vk, modifiers: 0 },
        { type: 'keyUp', key: modDef.key, code: modDef.code, windowsVirtualKeyCode: modDef.vk, modifiers: 0 },
      ];
    }
    throw new Error(`Invalid chord "${key}": no main key (only modifiers)`);
  }

  const def = resolveMainKey(mainPart, key);
  const active = MODIFIER_ORDER.filter((m) => flags[m]);

  const events: KeyEventParams[] = [];
  let mods = 0;
  for (const m of active) {
    const { def: mDef, bit } = MODIFIER_DEFS[m];
    mods |= bit;
    events.push({ type: 'rawKeyDown', key: mDef.key, code: mDef.code, windowsVirtualKeyCode: mDef.vk, modifiers: mods });
  }

  // Text is produced only for printable chars without Ctrl/Meta. With
  // Shift, letters go down with the uppercase char as key/text (CDP
  // convention); shifted symbols keep their base char (no US shift map).
  const producesText = def.text !== undefined && !flags.ctrl && !flags.meta;
  let mainKeyName = def.key;
  let text: string | undefined;
  let unmodifiedText: string | undefined;
  if (producesText) {
    unmodifiedText = def.text;
    const isLetter = /^[a-z]$/.test(def.text!);
    const shifted = isLetter && (flags.shift || mainPart !== mainPart!.toLowerCase());
    text = shifted ? def.text!.toUpperCase() : def.text!;
    if (isLetter) mainKeyName = text;
    events.push({
      type: 'keyDown',
      key: mainKeyName,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers: mods,
      text,
      unmodifiedText,
    });
  } else {
    events.push({
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers: mods,
    });
  }

  events.push({
    type: 'keyUp',
    key: mainKeyName,
    code: def.code,
    windowsVirtualKeyCode: def.vk,
    modifiers: mods,
  });

  for (const m of [...active].reverse()) {
    const { def: mDef, bit } = MODIFIER_DEFS[m];
    mods &= ~bit;
    events.push({ type: 'keyUp', key: mDef.key, code: mDef.code, windowsVirtualKeyCode: mDef.vk, modifiers: mods });
  }

  return events;
}
