// Keybindings.js — declarative keybinding table.
//
// Each entry maps a semantic action name to a key spec. A spec is either a
// bare `e.code` string or `{ key, mods, not, preventDefault }`. The help
// overlay text could later be generated from this table so it can't drift.

export const KEYBINDINGS = Object.freeze({
  'select.0': 'Digit1',
  'select.1': 'Digit2',
  'select.2': 'Digit3',
  'select.3': 'Digit4',
  'select.4': 'Digit5',
  'select.5': 'Digit6',
  'select.6': 'Digit7',
  'select.7': 'Digit8',
  'select.8': 'Digit9',
  'select.9': 'Digit0',
  'size.toggle': 'KeyB',
  'variant.cycle': 'KeyV',
  'item.rotate': 'KeyR',
  'inventory.toggle': 'KeyE',
  'help.toggle': { key: 'F1', preventDefault: true },
  'item.toggle': { key: 'F2', preventDefault: true },
  'equip.toggle': { key: 'F3', preventDefault: true },
  'npc.toggle': { key: 'F4', preventDefault: true },
  'test.toggle': { key: 'F5', preventDefault: true },
  'splash.capture': { key: 'F8', not: ['Shift'], preventDefault: true },
  'splash.delete': { key: 'F8', mods: ['Shift'], preventDefault: true },
  'mob.cycle': 'KeyG',
  'postfx.toggle': 'KeyP',
  'save': { key: 'KeyS', mods: ['Mod'], not: ['Shift'], preventDefault: true },
  'undo': { key: 'KeyZ', mods: ['Mod'], not: ['Shift'], preventDefault: true },
  'redo': { key: 'KeyZ', mods: ['Mod', 'Shift'], preventDefault: true },
});

/**
 * `e.code` names the physical key position (QWERTY naming), so on other
 * layouts the keycap label moves: a German QWERTZ keyboard reports the key
 * labelled Z as code KeyY — and Ctrl+Z would never match. Letter specs
 * therefore also accept the typed character, so shortcuts follow the label.
 */
function keyMatches(wanted, e) {
  if (e.code === wanted) return true;
  return wanted.startsWith('Key') && e.key?.toLowerCase() === wanted.slice(3).toLowerCase();
}

function matches(spec, e) {
  if (typeof spec === 'string') return keyMatches(spec, e);
  if (!keyMatches(spec.key, e)) return false;
  const mods = spec.mods ?? [];
  for (const m of mods) {
    if (m === 'Mod' && !(e.ctrlKey || e.metaKey)) return false;
    if (m === 'Shift' && !e.shiftKey) return false;
    if (m === 'Alt' && !e.altKey) return false;
  }
  const not = spec.not ?? [];
  for (const m of not) {
    if (m === 'Shift' && e.shiftKey) return false;
    if (m === 'Mod' && (e.ctrlKey || e.metaKey)) return false;
  }
  return true;
}

/**
 * Resolve a keyboard event to an action name, or null.
 * @returns {{action:string, spec:object}|null}
 */
export function resolveBinding(e) {
  for (const [action, spec] of Object.entries(KEYBINDINGS)) {
    if (matches(spec, e)) return { action, spec };
  }
  return null;
}
