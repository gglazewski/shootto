// SplashScreens.js — resolves which authored menu shots this game can show.
//
// A splash entry pairs a world (a WorldBundle) with the id of a splash camera
// stored inside that world. Two sources, richest first:
//
//   1. The dev server: /api/splash names worlds in the library, and each
//      world is fetched live — so freshly captured shots (F8 in the editor)
//      appear on the menu without a rebuild.
//   2. The embedded splash pack (map/splashpack.json baked into the build by
//      tools/pack_splash.mjs) — how deployed static builds get their shots.
//
// Returns [{ camId, worldText }] — the menu deserializes worldText on demand.
// The embedded pack is injected by the caller (see splashPack.js) rather than
// imported here, so this module stays importable in node tests (node can't
// import JSON modules the way the esbuild bundle can).

/** @returns {Promise<Array<{camId: string, worldText: string}>>} */
export async function loadSplashEntries(fetchFn = typeof fetch === 'function' ? fetch : null, pack = null) {
  const fromServer = fetchFn ? await loadFromServer(fetchFn) : [];
  if (fromServer.length) return fromServer;
  const packed = Array.isArray(pack?.entries) ? pack.entries : [];
  return packed
    .filter((e) => e && typeof e.cam === 'string' && e.bundle && typeof e.bundle === 'object')
    .map((e) => ({ camId: e.cam, worldText: JSON.stringify(e.bundle) }));
}

async function loadFromServer(fetchFn) {
  try {
    const res = await fetchFn('/api/splash');
    if (!res.ok) return [];
    const manifest = await res.json(); // static hosts return HTML here — throws, falls through
    if (!Array.isArray(manifest?.entries)) return [];
    const texts = new Map(); // one fetch per world, however many cams it hosts
    const out = [];
    for (const e of manifest.entries) {
      if (!e || typeof e.world !== 'string' || typeof e.cam !== 'string') continue;
      if (!texts.has(e.world)) {
        const url = `/api/worlds/${e.world.split('/').map(encodeURIComponent).join('/')}`;
        const r = await fetchFn(url);
        texts.set(e.world, r.ok ? await r.text() : null);
      }
      const worldText = texts.get(e.world);
      if (worldText) out.push({ camId: e.cam, worldText });
    }
    return out;
  } catch {
    return []; // no server (file://, static hosting) — use the embedded pack
  }
}
