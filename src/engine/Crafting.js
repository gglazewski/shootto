// Crafting.js — recipe registry + crafting rules.
//
// Recipes turn stackable materials (see engine/Materials.js) into craftable
// items (see engine/Craftables.js): melee weapons, armor vests and one-use
// healing consumables. Two stations:
//   - 'field': craftable anywhere by the player (C opens the crafting screen);
//     homemade weapons come out slightly worse for wear (SELF_CRAFT_DECAY).
//   - 'npc':   needs a craftsman — an NPC with the 'craft' service (see
//     NpcRegistry) makes it on their bench, full quality, for the same mats.
//
// The inventory interface is deliberately PlayerStats-shaped: anything with
// materialCount(id) / takeMaterial(id, count) works, so the game and the
// tests share one code path. Authored recipes can extend or replace the
// built-ins (same id wins) via deserializeRecipeRegistry. Pure module (no
// three.js/DOM).

/** Recipe groups shown as tabs in the crafting screen. */
export const CRAFT_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'weapon', label: 'Weapons' }),
  Object.freeze({ id: 'armor', label: 'Armor' }),
  Object.freeze({ id: 'medical', label: 'Medical' }),
]);

/** Fraction of a weapon's BASE durability a homemade weapon starts
 *  permanently down (its max durability caps lower) — a bench job doesn't. */
export const SELF_CRAFT_DECAY_FRACTION = 0.2;

/** Clamp helper for recipe numbers. */
const clampCount = (v, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(99, n)) : fallback;
};

/** Coerce a candidate recipe into a valid one, or null (bad/missing id). */
export function normalizeRecipe(recipe) {
  if (!recipe || typeof recipe.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(recipe.id)) return null;
  const inputs = (Array.isArray(recipe.inputs) ? recipe.inputs : [])
    .map((i) =>
      i && typeof i.id === 'string' && i.id
        ? { id: i.id, count: clampCount(i.count, 1) }
        : null,
    )
    .filter(Boolean);
  if (!inputs.length) return null;
  if (!recipe.output || typeof recipe.output.id !== 'string' || !recipe.output.id) return null;
  const category = CRAFT_CATEGORIES.some((c) => c.id === recipe.category) ? recipe.category : 'weapon';
  return {
    id: recipe.id,
    name: typeof recipe.name === 'string' && recipe.name.trim() ? recipe.name.trim() : recipe.id,
    desc: typeof recipe.desc === 'string' ? recipe.desc.trim() : '',
    category,
    station: recipe.station === 'npc' ? 'npc' : 'field',
    inputs,
    output: { id: recipe.output.id, count: clampCount(recipe.output.count, 1) },
    builtin: recipe.builtin === true,
  };
}

const REGISTRY = new Map();

/** Register (or replace) a recipe. @returns {object|null} the stored recipe */
export function registerRecipe(recipe) {
  const clean = normalizeRecipe(recipe);
  if (!clean) return null;
  REGISTRY.set(clean.id, clean);
  return clean;
}

/** Recipe by id, or null. */
export function getRecipe(id) {
  return REGISTRY.get(id) ?? null;
}

/** Every registered recipe, in insertion order. Built-ins first (they
 *  register first), authored overrides on top. */
export function listRecipes() {
  return [...REGISTRY.values()];
}

export function clearRecipes() {
  REGISTRY.clear();
}

/** True when the recipe can be made at the player's current station:
 *  field recipes work anywhere, npc recipes need a craftsman. */
export function recipeAvailable(recipe, hasNpc = false) {
  return recipe?.station === 'field' || !!hasNpc;
}

/**
 * What crafting `recipe` would consume, against what the inventory carries.
 * @param {object} recipe
 * @param {{materialCount(id:string):number}} inv  PlayerStats-shaped
 * @returns {{ok:boolean, take:{id:string,count:number}[],
 *            missing:{id:string,count:number,short:number}[]}}
 */
export function craftPlan(recipe, inv) {
  const take = [];
  const missing = [];
  for (const input of recipe.inputs) {
    const have = inv.materialCount(input.id);
    if (have >= input.count) {
      take.push({ ...input });
    } else {
      missing.push({ ...input, short: input.count - have });
    }
  }
  return { ok: missing.length === 0, take, missing };
}

/**
 * Consume the recipe's materials. No-op (null) when the plan doesn't cover
 * the costs — check craftPlan first (the UI disables the button).
 * @returns {{take:{id:string,count:number}[]}|null} what was consumed */
export function applyCraft(recipe, inv) {
  const plan = craftPlan(recipe, inv);
  if (!plan.ok) return null;
  for (const t of plan.take) inv.takeMaterial(t.id, t.count);
  return plan;
}

/**
 * Permanent durability loss a weapon starts with when self-crafted on the
 * fly (station 'field'). Bench-made (npc) weapons and non-weapons get 0.
 * @param {object|null} def  the crafted equip def
 * @returns {number} decay points (0 = pristine)
 */
export function selfCraftDecay(def) {
  if (def?.kind !== 'weapon') return 0;
  const durability = Math.round(Number(def.stats?.durability) || 0);
  if (!(durability > 0)) return 0; // unbreakable weapons don't decay
  return Math.min(durability - 1, Math.max(1, Math.ceil(durability * SELF_CRAFT_DECAY_FRACTION)));
}

/** The built-in recipe list (outputs are engine/Craftables.js items). */
export const BUILTIN_RECIPES = Object.freeze([
  {
    id: 'bandage', name: 'Bandage', category: 'medical', station: 'field',
    desc: 'Tightly wrapped cloth. Stops the bleeding, nothing more.',
    inputs: [{ id: 'rag', count: 2 }],
    output: { id: 'bandage', count: 1 },
    builtin: true,
  },
  {
    id: 'first-aid', name: 'First Aid Kit', category: 'medical', station: 'field',
    desc: 'A proper dressing kit — gauze, tape, and something that stings.',
    inputs: [{ id: 'rag', count: 3 }, { id: 'glue', count: 1 }],
    output: { id: 'first-aid', count: 1 },
    builtin: true,
  },
  {
    id: 'trauma-kit', name: 'Trauma Kit', category: 'medical', station: 'npc',
    desc: 'Everything a field hospital does, in one red box.',
    inputs: [{ id: 'rag', count: 3 }, { id: 'glue', count: 2 }],
    output: { id: 'trauma-kit', count: 1 },
    builtin: true,
  },
  {
    id: 'shiv', name: 'Glass Shiv', category: 'weapon', station: 'field',
    desc: 'A honed glass shard. Quick, quiet, fragile.',
    inputs: [{ id: 'scrap-glass', count: 2 }, { id: 'duck-tape', count: 1 }],
    output: { id: 'shiv', count: 1 },
    builtin: true,
  },
  {
    id: 'plank-club', name: 'Nailed Plank', category: 'weapon', station: 'field',
    desc: 'A plank, some nails, and bad intentions.',
    inputs: [{ id: 'scrap-wood', count: 3 }, { id: 'duck-tape', count: 1 }],
    output: { id: 'plank-club', count: 1 },
    builtin: true,
  },
  {
    id: 'rebar-spear', name: 'Rebar Spear', category: 'weapon', station: 'npc',
    desc: 'Ground-down rebar on a tape grip. Keep them at point.',
    inputs: [{ id: 'scrap-metal', count: 5 }, { id: 'duck-tape', count: 2 }],
    output: { id: 'rebar-spear', count: 1 },
    builtin: true,
  },
  {
    id: 'scrap-vest', name: 'Scrap Vest', category: 'armor', station: 'field',
    desc: 'A bent plate hung on straps. Better than a shirt.',
    inputs: [{ id: 'scrap-metal', count: 4 }, { id: 'glue', count: 1 }],
    output: { id: 'scrap-vest', count: 1 },
    builtin: true,
  },
  {
    id: 'plate-vest', name: 'Plated Vest', category: 'armor', station: 'npc',
    desc: 'Overlapping steel, riveted at a proper bench.',
    inputs: [{ id: 'scrap-metal', count: 6 }, { id: 'glue', count: 2 }],
    output: { id: 'plate-vest', count: 1 },
    builtin: true,
  },
].map((r) => Object.freeze(structuredClone(r))));

/** Register every built-in recipe (idempotent). Call at game/editor start;
 *  authored recipes loaded later under the same id win. */
export function registerBuiltinRecipes() {
  for (const recipe of BUILTIN_RECIPES) registerRecipe(recipe);
}

/** @returns {string} JSON of every registered recipe. Built-ins are code,
 *  not authored content — they are skipped like the built-in equip items. */
export function serializeRecipeRegistry() {
  return JSON.stringify(listRecipes().filter((r) => !r.builtin));
}

/** Load recipes from JSON text (array of recipe-shaped objects). Invalid
 *  text leaves the registry untouched. @returns {object[]} stored recipes */
export function deserializeRecipeRegistry(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data) {
    const stored = registerRecipe(entry);
    if (stored) out.push(stored);
  }
  return out;
}
