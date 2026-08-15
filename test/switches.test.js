// Wall switches (flip-switch decals driving game flags) and the light/door
// reactions bound to them. Pure Node — no three.js/DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE, getDecal } from '../src/engine/VoxelTypes.js';
import {
  isSwitchDecal, switchFlag, isSwitchOn, toggleSwitch, flipSwitch, setSwitchArt, canonicalDecalId, faceFromNormal, seedSwitchFlags,
} from '../src/engine/Switches.js';
import { setLightMode } from '../src/engine/Lights.js';
import { GameFlags, bindWorldReactions } from '../src/game/Reactions.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';

/** A wall cell with a switch decal on its south face, wired to `flag`. */
function worldWithSwitch(flag = 'power') {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 1, 0);
  assert.ok(w.placeDecal('decal_switch', 0, 1, 0, 'pz'));
  const decal = w.decalAt(0, 1, 0, 'pz');
  if (flag) decal.flag = flag;
  return { w, decal };
}

test('switch decal defs pair OFF art with hidden ON art', () => {
  const off = getDecal('decal_switch');
  const on = getDecal('decal_switch_on');
  assert.equal(off.switchOn, 'decal_switch_on');
  assert.equal(on.switchOff, 'decal_switch');
  assert.ok(on.hidden, 'the ON art stays out of the palette');
  assert.ok(!off.hidden);
  assert.equal(canonicalDecalId('decal_switch_on'), 'decal_switch');
  assert.equal(canonicalDecalId('decal_switch'), 'decal_switch');
  assert.equal(canonicalDecalId('decal_blood'), 'decal_blood');
});

test('faceFromNormal names the face a pick ray came in through', () => {
  assert.equal(faceFromNormal([0, 0, 1]), 'pz');
  assert.equal(faceFromNormal([-1, 0, 0]), 'nx');
  assert.equal(faceFromNormal([0, 1, 0]), 'py');
  assert.equal(faceFromNormal([0, 0, 0]), null);
  assert.equal(faceFromNormal(undefined), null);
});

test('toggleSwitch flips the flag; the art mirrors it through reactions', () => {
  const { w, decal } = worldWithSwitch('cellar-power');
  assert.ok(isSwitchDecal(decal));
  assert.equal(switchFlag(decal), 'cellar-power');
  const flags = new GameFlags();
  const unbind = bindWorldReactions(w, flags);
  assert.ok(!isSwitchOn(decal), 'starts off');

  assert.ok(toggleSwitch(flags, decal));
  assert.ok(flags.get('cellar-power'));
  assert.ok(isSwitchOn(decal), 'rocker art followed the flag');
  assert.equal(decal.decalId, 'decal_switch_on');

  toggleSwitch(flags, decal);
  assert.ok(!flags.get('cellar-power'));
  assert.equal(decal.decalId, 'decal_switch');
  unbind();
});

test('a switch without a flag still clicks its rocker, driving nothing', () => {
  const { w, decal } = worldWithSwitch('');
  const flags = new GameFlags();
  assert.equal(switchFlag(decal), null);
  assert.equal(toggleSwitch(flags, decal), false, 'no flag to toggle');
  assert.ok(flipSwitch(w, flags, decal), 'E still flips the art');
  assert.ok(isSwitchOn(decal));
  assert.equal(flags.raised.size, 0, 'no flag was raised');
  flipSwitch(w, flags, decal);
  assert.ok(!isSwitchOn(decal));
});

test('flipSwitch goes through the flag when one is wired', () => {
  const { w, decal } = worldWithSwitch('power');
  const flags = new GameFlags();
  bindWorldReactions(w, flags);
  assert.ok(flipSwitch(w, flags, decal));
  assert.ok(flags.get('power'));
  assert.ok(isSwitchOn(decal), 'art mirrored the flag');
});

test('two switches on one flag flip together', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 1, 0);
  w.place('concrete', SIZE.SMALL, 4, 1, 0);
  w.placeDecal('decal_switch', 0, 1, 0, 'pz');
  w.placeDecal('decal_switch', 4, 1, 0, 'pz');
  const a = w.decalAt(0, 1, 0, 'pz');
  const b = w.decalAt(4, 1, 0, 'pz');
  a.flag = b.flag = 'hall';
  const flags = new GameFlags();
  bindWorldReactions(w, flags);
  toggleSwitch(flags, a);
  assert.ok(isSwitchOn(a) && isSwitchOn(b), 'both mirror the shared flag');
});

test('seedSwitchFlags raises the flags of switches authored to start ON', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 1, 0);
  w.place('concrete', SIZE.SMALL, 4, 1, 0);
  w.place('concrete', SIZE.SMALL, 8, 1, 0);
  w.placeDecal('decal_switch', 0, 1, 0, 'pz');
  w.placeDecal('decal_switch', 4, 1, 0, 'pz');
  w.placeDecal('decal_blood', 8, 1, 0, 'pz');
  const on = w.decalAt(0, 1, 0, 'pz');
  on.flag = 'power';
  on.startOn = true;
  const off = w.decalAt(4, 1, 0, 'pz');
  off.flag = 'alarm';
  const scenery = w.decalAt(8, 1, 0, 'pz');
  scenery.startOn = true; // not a switch — must be ignored

  const flags = new GameFlags();
  seedSwitchFlags(w, flags);
  assert.ok(flags.get('power'), 'startOn switch raised its flag');
  assert.ok(!flags.get('alarm'), 'plain switch stays down');
  assert.equal(flags.raised.size, 1);

  bindWorldReactions(w, flags);
  assert.ok(isSwitchOn(on), 'binding settles the ON art');
  assert.ok(!isSwitchOn(off));
});

test('copyFrom keeps switch wiring and light flags (the editor load path)', () => {
  // The editor never adopts a loaded World — it copies it into the live one
  // (App.replaceWorldVoxels). Dropping the wiring here silently strips every
  // map on the next autosave.
  const { w, decal } = worldWithSwitch('power');
  decal.startOn = true;
  w.place('lamp', SIZE.SMALL, 4, 5, 0);
  const lamp = w.get(4, 5, 0);
  lamp.lightFlag = 'power';
  lamp.lightMode = 'flicker';

  const w2 = new World();
  w2.copyFrom(w);
  const d2 = w2.decalAt(0, 1, 0, 'pz');
  assert.equal(d2.flag, 'power', 'switch flag survives the copy');
  assert.equal(d2.startOn, true, 'startOn survives the copy');
  const lamp2 = w2.get(4, 5, 0);
  assert.equal(lamp2.lightFlag, 'power', 'light flag survives the copy');
  assert.equal(lamp2.lightMode, 'flicker', 'light mode survives the copy');
});

test('startOn round-trips through world save/load', () => {
  const { w, decal } = worldWithSwitch('power');
  decal.startOn = true;
  const raw = JSON.parse(serialize(w));
  assert.equal(raw.decals[0].startOn, true);
  const { world: w2, errors } = deserialize(JSON.stringify(raw));
  assert.equal(errors.length, 0);
  assert.equal(w2.decalAt(0, 1, 0, 'pz').startOn, true);
  // Unset stays omitted — untouched maps keep their bytes.
  delete decal.startOn;
  assert.ok(!('startOn' in JSON.parse(serialize(w)).decals[0]));
});

test('switch flag round-trips and ON art normalizes to the OFF id in saves', () => {
  const { w, decal } = worldWithSwitch('power');
  setSwitchArt(w, decal, true); // caught mid-game showing ON
  const raw = JSON.parse(serialize(w));
  assert.equal(raw.decals[0].id, 'decal_switch');
  assert.equal(raw.decals[0].flag, 'power');
  const { world: w2, errors } = deserialize(JSON.stringify(raw));
  assert.equal(errors.length, 0);
  const d2 = w2.decalAt(0, 1, 0, 'pz');
  assert.equal(d2.decalId, 'decal_switch');
  assert.equal(d2.flag, 'power');
});

test('a light bound to a flag is dark until the flag rises', () => {
  const w = new World();
  w.place('lamp', SIZE.SMALL, 0, 5, 0);
  const v = w.get(0, 5, 0);
  v.lightFlag = 'power';
  const flags = new GameFlags();
  const unbind = bindWorldReactions(w, flags);
  assert.equal(v.type, 'lamp_off', 'catch-up cuts the power of an unraised flag');

  flags.set('power', true);
  assert.equal(v.type, 'lamp', 'raising the flag restores the authored mode');
  flags.set('power', false);
  assert.equal(v.type, 'lamp_off');
  unbind();
});

test('a flag-powered flickering light keeps its authored mode when powered', () => {
  const w = new World();
  w.place('lamp', SIZE.SMALL, 0, 5, 0);
  const v = w.get(0, 5, 0);
  setLightMode(w, v, 'flicker');
  v.lightFlag = 'power';
  const flags = new GameFlags();
  bindWorldReactions(w, flags);
  assert.equal(v.type, 'lamp_off', 'unpowered: dark, no strobe');
  assert.equal(v.lightMode, 'flicker', 'the authored mode survives the power cut');
  flags.set('power', true);
  assert.equal(v.type, 'lamp', 'powered again: lit, ready to strobe');
});

test("'!flag' inverts a light's power binding", () => {
  const w = new World();
  w.place('neon', SIZE.SMALL, 0, 5, 0);
  const v = w.get(0, 5, 0);
  v.lightFlag = '!alarm';
  const flags = new GameFlags();
  bindWorldReactions(w, flags);
  assert.equal(v.type, 'neon', 'lit while the flag is down');
  flags.set('alarm', true);
  assert.equal(v.type, 'neon_off', 'raising the flag cuts it');
});

test('a switch flipping a flag drives a door lock and a light at once', () => {
  const w = new World();
  w.place('concrete', SIZE.SMALL, 0, 1, 0);
  w.placeDecal('decal_switch', 0, 1, 0, 'pz');
  const sw = w.decalAt(0, 1, 0, 'pz');
  sw.flag = 'backroom';
  w.place('lamp', SIZE.SMALL, 4, 5, 0);
  const lamp = w.get(4, 5, 0);
  lamp.lightFlag = 'backroom';
  w.place('door_wood', SIZE.DOOR, 8, 0, 0);
  const door = w.get(8, 0, 0);
  door.unlockFlag = 'backroom';

  const flags = new GameFlags();
  let unlocked = 0;
  bindWorldReactions(w, flags, { onDoorUnlock: () => unlocked++ });
  assert.equal(lamp.type, 'lamp_off');
  assert.ok(door.locked, 'flag-gated door starts locked');

  toggleSwitch(flags, sw);
  assert.equal(lamp.type, 'lamp');
  assert.ok(!door.locked);
  assert.equal(unlocked, 1);
  assert.ok(isSwitchOn(sw));
});
