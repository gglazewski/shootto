// PlayerStats.js — pure player model for the playable game.
//
// Holds health (0..100) and armor (0..100) plus four equipment slots
// (primary / secondary / extra / injection). Slots hold item ids (strings) or
// null, and an ammo inventory tracks how many rounds of each ammo type the
// player carries (capped by the type's max stack). Each slot also tracks wear
// — how many hits its melee weapon has landed on mobs — so weapons can break
// when wear reaches their durability (see GameApp). No three.js/DOM, so it can
// be unit tested in Node. Save slots persist the whole model via
// serialize()/deserialize().

import { AMMO_TYPES, startingAmmo, clampAmmo, isAmmoId } from '../engine/AmmoTypes.js';

export const MAX_HEALTH = 100;
export const MAX_ARMOR = 100;
export const EQUIPMENT_SLOTS = Object.freeze(['primary', 'secondary', 'extra', 'injection']);

/** Injection heal amount (consumes the injection when used). */
export const INJECTION_HEAL = 40;

const clamp = (n, min = 0, max = 100) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return max;
  return Math.max(min, Math.min(max, v));
};

export class PlayerStats {
  /**
   * @param {object} [init]
   * @param {number} [init.health]
   * @param {number} [init.armor]
   * @param {object} [init.equipment]  { primary?: string, secondary?: string,
   *   extra?: string, injection?: string } — item ids
   * @param {object} [init.ammo]  { pistol?: number, rifle?: number,
   *   shotgun?: number } — carried ammo per type
   * @param {object} [init.wear]  landed melee hits per slot (weapon wear)
   */
  constructor({ health = MAX_HEALTH, armor = 0, equipment = {}, ammo, wear } = {}) {
    this.health = clamp(health);
    // Armor starts at zero — it only comes from armor pickups (vests built
    // in the F3 editor). NaN-safe clamp would default to max, so guard it.
    this.armor = Number.isFinite(Number(armor)) ? clamp(armor) : 0;
    /** @type {{primary:string|null, secondary:string|null, extra:string|null, injection:string|null}} */
    this.equipment = { primary: null, secondary: null, extra: null, injection: null };
    if (equipment && typeof equipment === 'object') {
      for (const slot of EQUIPMENT_SLOTS) {
        if (equipment[slot]) this.equipment[slot] = equipment[slot];
      }
    }
    /** @type {Record<string, number>} landed melee hits per slot — wear on the
     *  equipped weapon. Resets whenever the slot's item changes. */
    this.wear = { primary: 0, secondary: 0, extra: 0, injection: 0 };
    if (wear && typeof wear === 'object') {
      for (const slot of EQUIPMENT_SLOTS) {
        const w = Math.round(Number(wear[slot]));
        if (Number.isFinite(w) && w > 0 && this.equipment[slot]) this.wear[slot] = w;
      }
    }
    /** @type {Record<string, number>} carried ammo per type, capped by max stack. */
    this.ammo = startingAmmo();
    if (ammo && typeof ammo === 'object') {
      for (const [id, count] of Object.entries(ammo)) {
        if (isAmmoId(id)) this.ammo[id] = clampAmmo(id, count);
      }
    }
    /** Index into EQUIPMENT_SLOTS for the "in hand" slot (default primary). */
    this.activeSlot = EQUIPMENT_SLOTS.indexOf('primary');
  }

  /** Name of the currently selected slot, e.g. 'primary'. */
  get activeSlotName() {
    return EQUIPMENT_SLOTS[this.activeSlot];
  }

  /** Item id in the currently selected slot (null = fists). */
  get activeItemId() {
    return this.equipment[this.activeSlotName] ?? null;
  }

  /**
   * Apply damage: armor absorbs part of it first, the rest hits health.
   * @returns {{health:number, armor:number, absorbed:number}} updated values
   */
  damage(amount) {
    const absorbed = Math.min(this.armor, amount * 0.6);
    this.armor = clamp(this.armor - absorbed);
    this.health = clamp(this.health - (amount - absorbed));
    return { health: this.health, armor: this.armor, absorbed };
  }

  /** Restore health up to the max. @returns {number} new health */
  heal(amount) {
    this.health = clamp(this.health + amount);
    return this.health;
  }

  /** Restore armor up to the max. @returns {number} new armor */
  repair(amount) {
    this.armor = clamp(this.armor + amount);
    return this.armor;
  }

  /** Equip an item id into a slot. A different item arrives fresh — its wear
   *  resets. @param {string} slot @param {string|null} itemId */
  equip(slot, itemId) {
    if (!EQUIPMENT_SLOTS.includes(slot)) return false;
    if (this.equipment[slot] !== (itemId ?? null)) this.wear[slot] = 0;
    this.equipment[slot] = itemId ?? null;
    return true;
  }

  /** Count one landed melee hit on the item in a slot.
   *  @returns {number} the slot's total wear */
  addWear(slot) {
    if (!EQUIPMENT_SLOTS.includes(slot)) return 0;
    this.wear[slot] += 1;
    return this.wear[slot];
  }

  /** Undo a slot's weapon wear (an NPC repair service). @returns {boolean} */
  repairWear(slot) {
    if (!EQUIPMENT_SLOTS.includes(slot)) return false;
    this.wear[slot] = 0;
    return true;
  }

  /** Clear a slot. */
  unequip(slot) {
    return this.equip(slot, null);
  }

  /** Select a slot by index. @returns {boolean} */
  setActiveSlot(index) {
    if (index < 0 || index >= EQUIPMENT_SLOTS.length) return false;
    this.activeSlot = index;
    return true;
  }

  /** Heal with the injection if one is equipped; consumes it. @returns {boolean} */
  useInjection() {
    if (!this.equipment.injection) return false;
    this.heal(INJECTION_HEAL);
    this.equipment.injection = null;
    return true;
  }

  get isDead() {
    return this.health <= 0;
  }

  /** @returns {object} plain data for save slots / JSON */
  serialize() {
    return {
      health: this.health,
      armor: this.armor,
      equipment: { ...this.equipment },
      activeSlot: this.activeSlot,
      ammo: { ...this.ammo },
      wear: { ...this.wear },
    };
  }

  /** @returns {PlayerStats} */
  static deserialize(data) {
    if (!data || typeof data !== 'object') return new PlayerStats();
    const stats = new PlayerStats({
      health: data.health,
      armor: data.armor,
      equipment: data.equipment,
      ammo: data.ammo,
      wear: data.wear,
    });
    if (Number.isInteger(data.activeSlot)) stats.setActiveSlot(data.activeSlot);
    return stats;
  }

  /** Add ammo to a type, clamped to its max stack. @returns {number} new count */
  addAmmo(type, amount) {
    if (!isAmmoId(type)) return this.ammo[type] ?? 0;
    this.ammo[type] = clampAmmo(type, (this.ammo[type] ?? 0) + amount);
    return this.ammo[type];
  }

  /** Take ammo from a type (never below 0). @returns {number} amount taken */
  takeAmmo(type, amount) {
    if (!isAmmoId(type)) return 0;
    const taken = Math.min(amount, this.ammo[type] ?? 0);
    this.ammo[type] = (this.ammo[type] ?? 0) - taken;
    return taken;
  }
}
